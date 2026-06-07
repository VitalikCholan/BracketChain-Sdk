import {
  AccountRole,
  type AccountMeta,
  type Address,
  type Instruction,
  type Signature,
} from "@solana/kit";

import type { BracketChainClient } from "../client";
import {
  BracketChainSDKError,
  MinParticipantsNotMetError,
  RegistrationClosedError,
  SeedNotRevealedError,
  UnauthorizedReporterError,
  mapError,
} from "../errors";
import {
  fetchTournament,
  getStartTournamentInstruction,
  SettlementMode,
  TournamentStatus,
  type MatchInitDescriptor,
} from "../generated";
import { findMatchPda, findParticipantPda } from "../pdas";
import { round0Expected, seedPermutation } from "../seeding";
import { assertSigner, sendInstructions } from "./_send";
import { listParticipants } from "./queries";

// ─────────────────────────────────────────────────────────────────────────────
// Tx-budget chunking constants — see notes in the original SDK; same envelope
// since the on-chain handler is unchanged.
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_CHUNK_SIZE = 7;
// VRF-seeded chunks also carry up to 2 Participant accounts per match for the
// on-chain seed-consistency check (H-2), so they fit fewer matches per tx.
const VRF_CHUNK_SIZE = 3;
const DEFAULT_COMPUTE_UNITS = 400_000;

const DEFAULT_PLAYER: Address = "11111111111111111111111111111111" as Address;

export interface StartTournamentParams {
  tournamentPda: Address;
  /**
   * Player wallets in seed order. If omitted, the SDK auto-discovers via
   * `getProgramAccounts` and orders ascending by `seedIndex`.
   */
  participantWallets?: Address[];
  /** Match-PDA inits per tx. Default 7. */
  chunkSize?: number;
  /** Compute budget per chunk. Default 400_000. */
  computeUnits?: number;
}

export interface StartTournamentResult {
  txSignatures: Signature[];
  bracketSize: number;
  totalMatches: number;
}

/**
 * Initialize the bracket and transition Registration → Active.
 *
 * Lifecycle (mirrors on-chain `start_tournament`):
 *  1. First chunk: program captures `seed_hash` from the SlotHashes sysvar,
 *     computes bracket_size = next_pow_of_2(participant_count), flips status
 *     Registration → PendingBracketInit, then inits its descriptors.
 *  2. Subsequent chunks: status is PendingBracketInit. Program inits more
 *     match PDAs.
 *  3. Last chunk fills the final descriptor → status flips to Active.
 *
 * Each chunk runs with a 400K compute-unit budget by default.
 */
export async function startTournament(
  client: BracketChainClient,
  params: StartTournamentParams,
): Promise<StartTournamentResult> {
  const signer = assertSigner(client, "startTournament");
  const organizer = signer.address;
  const tournamentPda = params.tournamentPda;

  // ── read tournament + validate ────────────────────────────────────────────
  let tournament;
  try {
    tournament = (await fetchTournament(client.rpc, tournamentPda)).data;
  } catch (err) {
    throw mapError(err);
  }

  if (tournament.organizer !== organizer) {
    throw new UnauthorizedReporterError();
  }
  if (
    tournament.status !== TournamentStatus.Registration &&
    tournament.status !== TournamentStatus.PendingBracketInit
  ) {
    throw new RegistrationClosedError();
  }
  if (tournament.participantCount < 2) {
    throw new MinParticipantsNotMetError();
  }

  // ── resolve participants, sorted by seed_index ────────────────────────────
  const participantWallets = await resolveParticipantWallets(
    client,
    tournamentPda,
    tournament.participantCount,
    params.participantWallets,
  );

  // ── build full descriptor list ────────────────────────────────────────────
  const vrfMode = tournament.settlementMode !== SettlementMode.OrganizerOnly;
  // VRF-gated brackets (H-2c): building descriptors from an unrevealed
  // (all-zero) seedHash would derive a garbage permutation and fail on-chain
  // with a raw SeedNotRevealed on the first chunk — fail fast with the typed
  // error before doing any work instead.
  if (vrfMode && !tournament.seedRevealed) {
    throw new SeedNotRevealedError();
  }
  const { descriptors, matchPdas, participantsPerDescriptor, bracketSize } =
    await buildBracketDescriptors(tournamentPda, participantWallets, {
      vrfMode,
      seedHash: new Uint8Array(tournament.seedHash),
    });

  // Skip already-initialized matches (idempotent resume).
  const alreadyInit = tournament.matchesInitialized;
  const remainingDescriptors = descriptors.slice(alreadyInit);
  const remainingPdas = matchPdas.slice(alreadyInit);
  const remainingParticipants = participantsPerDescriptor.slice(alreadyInit);

  // ── chunk + send sequentially ─────────────────────────────────────────────
  // VRF chunks carry a Participant tail, so they default smaller.
  const defaultChunk = vrfMode ? VRF_CHUNK_SIZE : DEFAULT_CHUNK_SIZE;
  const chunkSize = Math.max(1, Math.min(params.chunkSize ?? defaultChunk, 12));
  const computeUnits = params.computeUnits ?? DEFAULT_COMPUTE_UNITS;
  const txSignatures: Signature[] = [];

  for (let i = 0; i < remainingDescriptors.length; i += chunkSize) {
    const dChunk = remainingDescriptors.slice(i, i + chunkSize);
    const pdaChunk = remainingPdas.slice(i, i + chunkSize);
    // Participant tail in descriptor order — the program consumes it with a
    // cursor mirroring this exact ordering (match PDAs first, then the tail).
    const tail = remainingParticipants.slice(i, i + chunkSize).flat();

    const remainingAccounts: AccountMeta[] = [
      ...pdaChunk.map((address) => ({ address, role: AccountRole.WRITABLE })),
      ...tail.map((address) => ({ address, role: AccountRole.READONLY })),
    ];

    const ix = getStartTournamentInstruction({
      organizer: signer,
      tournament: tournamentPda,
      descriptors: dChunk,
    });

    const ixWithRemaining: Instruction = {
      ...ix,
      accounts: [...(ix.accounts ?? []), ...remainingAccounts],
    };

    const sig = await sendInstructions(client, signer, [ixWithRemaining], {
      computeUnits,
    });
    txSignatures.push(sig);
  }

  return {
    txSignatures,
    bracketSize,
    totalMatches: bracketSize - 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function resolveParticipantWallets(
  client: BracketChainClient,
  tournamentPda: Address,
  expectedCount: number,
  override?: Address[],
): Promise<Address[]> {
  if (override && override.length > 0) {
    if (override.length !== expectedCount) {
      throw new BracketChainSDKError(
        `participantWallets length (${override.length}) does not match on-chain participantCount (${expectedCount})`,
        "InvalidArgument",
      );
    }
    return override;
  }

  const participants = await listParticipants(client, tournamentPda);
  if (participants.length !== expectedCount) {
    throw new BracketChainSDKError(
      `Expected ${expectedCount} participants on-chain, found ${participants.length}. RPC may be lagging — retry, or pass participantWallets explicitly.`,
      "ParticipantCountMismatch",
    );
  }
  return participants.map((p) => p.account.wallet);
}

function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

interface BuildBracketResult {
  descriptors: MatchInitDescriptor[];
  matchPdas: Address[];
  /**
   * Per-descriptor Participant PDAs the program validates against the seed
   * (VRF mode); empty arrays for OrganizerOnly. Parallel to `descriptors`.
   */
  participantsPerDescriptor: Address[][];
  bracketSize: number;
}

/**
 * Build the full single-elim bracket.
 *
 * VRF mode (non-OrganizerOnly): players are placed by the seed-derived
 * Fisher-Yates permutation under standard seeding (rank `m` vs
 * `bracketSize-1-m`), byes against the top seeds. Each placed player carries its
 * Participant PDA so the program can verify `participant.seedIndex == perm[rank]`
 * — this must match `seeding.rs` / `validate_descriptor_against_seed`
 * byte-for-byte (pinned by the shared golden vector in `seeding.test.ts`).
 *
 * OrganizerOnly: legacy join-order pairing, byes padded at the end, no tail.
 */
async function buildBracketDescriptors(
  tournament: Address,
  players: Address[],
  opts: { vrfMode: boolean; seedHash: Uint8Array },
): Promise<BuildBracketResult> {
  const N = players.length;
  if (N < 2) {
    throw new MinParticipantsNotMetError();
  }

  const bracketSize = nextPowerOfTwo(N);
  const totalRounds = Math.log2(bracketSize);

  const descriptors: MatchInitDescriptor[] = [];
  const matchPdas: Address[] = [];
  const participantsPerDescriptor: Address[][] = [];

  // ── Legacy OrganizerOnly path: join-order pairing, byes padded at the end ──
  if (!opts.vrfMode) {
    const padded = [...players];
    while (padded.length < bracketSize) padded.push(DEFAULT_PLAYER);
    const round0ByeWinners: Array<Address | null> = [];
    const round0Matches = bracketSize >> 1;
    for (let m = 0; m < round0Matches; m++) {
      const a = padded[2 * m]!;
      const b = padded[2 * m + 1]!;
      const aIsDefault = a === DEFAULT_PLAYER;
      const bIsDefault = b === DEFAULT_PLAYER;
      const bye = aIsDefault || bIsDefault;
      const playerA = bye ? (aIsDefault ? b : a) : a;
      const playerB = bye ? DEFAULT_PLAYER : b;
      const [pda, bump] = await findMatchPda({ tournament, bracket: 0, round: 0, matchIndex: m });
      descriptors.push({ bracket: 0, round: 0, matchIndex: m, bump, playerA, playerB, bye });
      matchPdas.push(pda);
      participantsPerDescriptor.push([]);
      round0ByeWinners.push(bye ? playerA : null);
    }
    for (let r = 1; r < totalRounds; r++) {
      const matches = bracketSize >> (r + 1);
      for (let m = 0; m < matches; m++) {
        let playerA: Address = DEFAULT_PLAYER;
        let playerB: Address = DEFAULT_PLAYER;
        if (r === 1) {
          playerA = round0ByeWinners[2 * m] ?? DEFAULT_PLAYER;
          playerB = round0ByeWinners[2 * m + 1] ?? DEFAULT_PLAYER;
        }
        const [pda, bump] = await findMatchPda({ tournament, bracket: 0, round: r, matchIndex: m });
        descriptors.push({ bracket: 0, round: r, matchIndex: m, bump, playerA, playerB, bye: false });
        matchPdas.push(pda);
        participantsPerDescriptor.push([]);
      }
    }
    return { descriptors, matchPdas, participantsPerDescriptor, bracketSize };
  }

  // ── VRF path: canonical seed-derived bracket (mirrors seeding.rs) ──────────
  const perm = seedPermutation(opts.seedHash, N);
  // Participant PDA per wallet (async, precomputed once).
  const partPda = new Map<Address, Address>();
  for (const wallet of players) {
    const [pda] = await findParticipantPda({ tournament, player: wallet });
    partPda.set(wallet, pda);
  }
  // Wallet at a given seed-rank, or null for a bye slot (rank ≥ N).
  const rankWallet = (rank: number): Address | null =>
    rank < N ? players[perm[rank]!]! : null;
  const round0IsBye = (k: number): boolean =>
    round0Expected(perm, k, bracketSize, N)[1] === null;

  // ── Round 0: standard seeding, rank m vs bracketSize-1-m ──
  const round0Matches = bracketSize >> 1;
  for (let m = 0; m < round0Matches; m++) {
    const aWallet = rankWallet(m)!; // rank m < bracketSize/2 < N → always real
    const bWallet = rankWallet(bracketSize - 1 - m);
    const bye = bWallet === null;
    const [pda, bump] = await findMatchPda({ tournament, bracket: 0, round: 0, matchIndex: m });
    descriptors.push({
      bracket: 0,
      round: 0,
      matchIndex: m,
      bump,
      playerA: aWallet,
      playerB: bye ? DEFAULT_PLAYER : bWallet!,
      bye,
    });
    matchPdas.push(pda);
    participantsPerDescriptor.push(
      bye ? [partPda.get(aWallet)!] : [partPda.get(aWallet)!, partPda.get(bWallet!)!],
    );
  }

  // ── Rounds 1+: only round-0 byes pre-fill round 1; everything else empty ──
  for (let r = 1; r < totalRounds; r++) {
    const matches = bracketSize >> (r + 1);
    for (let m = 0; m < matches; m++) {
      let playerA: Address = DEFAULT_PLAYER;
      let playerB: Address = DEFAULT_PLAYER;
      const parts: Address[] = [];
      if (r === 1) {
        const parentA = 2 * m;
        const parentB = 2 * m + 1;
        if (round0IsBye(parentA)) {
          const w = rankWallet(parentA)!;
          playerA = w;
          parts.push(partPda.get(w)!);
        }
        if (round0IsBye(parentB)) {
          const w = rankWallet(parentB)!;
          playerB = w;
          parts.push(partPda.get(w)!);
        }
      }
      const [pda, bump] = await findMatchPda({ tournament, bracket: 0, round: r, matchIndex: m });
      descriptors.push({ bracket: 0, round: r, matchIndex: m, bump, playerA, playerB, bye: false });
      matchPdas.push(pda);
      participantsPerDescriptor.push(parts);
    }
  }

  return { descriptors, matchPdas, participantsPerDescriptor, bracketSize };
}

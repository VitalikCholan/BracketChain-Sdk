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
  UnauthorizedReporterError,
  mapError,
} from "../errors";
import {
  fetchTournament,
  getStartTournamentInstruction,
  TournamentStatus,
  type MatchInitDescriptor,
} from "../generated";
import { findMatchPda } from "../pdas";
import { assertSigner, sendInstructions } from "./_send";
import { listParticipants } from "./queries";

// ─────────────────────────────────────────────────────────────────────────────
// Tx-budget chunking constants — see notes in the original SDK; same envelope
// since the on-chain handler is unchanged.
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_CHUNK_SIZE = 7;
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
  const { descriptors, matchPdas, bracketSize } =
    await buildBracketDescriptors(tournamentPda, participantWallets);

  // Skip already-initialized matches (idempotent resume).
  const alreadyInit = tournament.matchesInitialized;
  const remainingDescriptors = descriptors.slice(alreadyInit);
  const remainingPdas = matchPdas.slice(alreadyInit);

  // ── chunk + send sequentially ─────────────────────────────────────────────
  const chunkSize = Math.max(
    1,
    Math.min(params.chunkSize ?? DEFAULT_CHUNK_SIZE, 12),
  );
  const computeUnits = params.computeUnits ?? DEFAULT_COMPUTE_UNITS;
  const txSignatures: Signature[] = [];

  for (let i = 0; i < remainingDescriptors.length; i += chunkSize) {
    const dChunk = remainingDescriptors.slice(i, i + chunkSize);
    const pdaChunk = remainingPdas.slice(i, i + chunkSize);

    const remainingAccounts: AccountMeta[] = pdaChunk.map((address) => ({
      address,
      role: AccountRole.WRITABLE,
    }));

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
  bracketSize: number;
}

/**
 * Build the full bracket: round 0 pairs `[seeds[2i], seeds[2i+1]]`, with byes
 * for top seeds when N < bracket_size. Round 1+ have player slots pre-populated
 * only for parent matches that are byes.
 */
async function buildBracketDescriptors(
  tournament: Address,
  players: Address[],
): Promise<BuildBracketResult> {
  const N = players.length;
  if (N < 2) {
    throw new MinParticipantsNotMetError();
  }

  const bracketSize = nextPowerOfTwo(N);
  const totalRounds = Math.log2(bracketSize);
  const padded = [...players];
  while (padded.length < bracketSize) padded.push(DEFAULT_PLAYER);

  const descriptors: MatchInitDescriptor[] = [];
  const matchPdas: Address[] = [];

  // ── Round 0 ───────────────────────────────────────────────────────────────
  const round0Matches = bracketSize >> 1;
  const round0ByeWinners: Array<Address | null> = [];
  for (let m = 0; m < round0Matches; m++) {
    const a = padded[2 * m]!;
    const b = padded[2 * m + 1]!;
    const aIsDefault = a === DEFAULT_PLAYER;
    const bIsDefault = b === DEFAULT_PLAYER;
    const bye = aIsDefault || bIsDefault;
    const playerA = bye ? (aIsDefault ? b : a) : a;
    const playerB = bye ? DEFAULT_PLAYER : b;

    const [pda, bump] = await findMatchPda({
      tournament,
      bracket: 0,
      round: 0,
      matchIndex: m,
    });
    descriptors.push({
      bracket: 0,
      round: 0,
      matchIndex: m,
      bump,
      playerA,
      playerB,
      bye,
    });
    matchPdas.push(pda);
    round0ByeWinners.push(bye ? playerA : null);
  }

  // ── Rounds 1+ ────────────────────────────────────────────────────────────
  for (let r = 1; r < totalRounds; r++) {
    const matches = bracketSize >> (r + 1);
    for (let m = 0; m < matches; m++) {
      let playerA: Address = DEFAULT_PLAYER;
      let playerB: Address = DEFAULT_PLAYER;
      if (r === 1) {
        playerA = round0ByeWinners[2 * m] ?? DEFAULT_PLAYER;
        playerB = round0ByeWinners[2 * m + 1] ?? DEFAULT_PLAYER;
      }
      const [pda, bump] = await findMatchPda({
        tournament,
        bracket: 0,
        round: r,
        matchIndex: m,
      });
      descriptors.push({
        bracket: 0,
        round: r,
        matchIndex: m,
        bump,
        playerA,
        playerB,
        bye: false,
      });
      matchPdas.push(pda);
    }
  }

  return { descriptors, matchPdas, bracketSize };
}

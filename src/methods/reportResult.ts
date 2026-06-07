import {
  AccountRole,
  type AccountMeta,
  type Address,
  type Instruction,
  type Signature,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

import type { BracketChainClient } from "../client";
import {
  BracketChainSDKError,
  InvalidMatchError,
  InvalidPayoutPresetError,
  MatchAlreadyReportedError,
  NonParticipantWinnerError,
  TournamentNotActiveError,
  UnauthorizedReporterError,
  mapError,
} from "../errors";
import {
  fetchMatchNode,
  fetchProtocolConfig,
  fetchTournament,
  findProtocolConfigPda,
  findVaultPda,
  getReportResultInstructionAsync,
  MatchStatus,
  PayoutPreset,
  TournamentStatus,
  type Tournament,
  type MatchNode,
} from "../generated";
import { findMatchPda } from "../pdas";
import { assertSigner, sendInstructions } from "./_send";

export interface ReportResultParams {
  tournamentPda: Address;
  /** 0-indexed round of the match being reported. */
  round: number;
  /** 0-indexed match position within the round. */
  matchIndex: number;
  /** Winner address — must equal `playerA` or `playerB` on the match account. */
  winner: Address;
  /**
   * Required ONLY when reporting the final match. Length + ordering:
   *  - WTA (1):      [champion]
   *  - Standard (3): [champion, runnerUp, third]
   *  - Deep (7):     [champion, runnerUp, third, 5–8, 5–8, 5–8, 5–8]
   *
   * Position 0 must equal `winner`; position 1 must be the loser of the final
   * match. Positions 2+ are organizer-trusted in MVP.
   */
  placements?: Address[];
}

export interface ReportResultResult {
  txSignature: Signature;
  isFinal: boolean;
}

/**
 * Report a match winner. For non-final matches, advances the winner into the
 * next-round match's player slot. For the final match, distributes the prize
 * pool per the tournament's payout preset and flips status to Completed.
 */
export async function reportResult(
  client: BracketChainClient,
  params: ReportResultParams,
): Promise<ReportResultResult> {
  const signer = assertSigner(client, "reportResult");
  const organizer = signer.address;
  const tournamentPda = params.tournamentPda;

  // ── read tournament + match ──────────────────────────────────────────────
  let tournament: Tournament;
  try {
    tournament = (await fetchTournament(client.rpc, tournamentPda)).data;
  } catch (err) {
    throw mapError(err);
  }

  if (tournament.organizer !== organizer) {
    throw new UnauthorizedReporterError();
  }
  if (tournament.status !== TournamentStatus.Active) {
    throw new TournamentNotActiveError();
  }

  const [matchPda] = await findMatchPda({
    tournament: tournamentPda,
    round: params.round,
    matchIndex: params.matchIndex,
  });

  let matchAccount: MatchNode;
  try {
    matchAccount = (await fetchMatchNode(client.rpc, matchPda)).data;
  } catch (err) {
    throw mapError(err);
  }

  if (matchAccount.status === MatchStatus.Completed) {
    throw new MatchAlreadyReportedError();
  }
  if (matchAccount.status !== MatchStatus.Active) {
    throw new InvalidMatchError();
  }
  if (
    params.winner !== matchAccount.playerA &&
    params.winner !== matchAccount.playerB
  ) {
    throw new NonParticipantWinnerError();
  }

  const maxRound = Math.log2(tournament.bracketSize);
  const isFinal = params.round + 1 === maxRound && params.matchIndex === 0;

  if (!isFinal) {
    return reportNonFinal(client, params, signer, tournamentPda, matchPda);
  }
  return reportFinal(
    client,
    params,
    signer,
    tournamentPda,
    matchPda,
    matchAccount,
    tournament,
  );
}

async function reportNonFinal(
  client: BracketChainClient,
  params: ReportResultParams,
  signer: ReturnType<typeof assertSigner>,
  tournamentPda: Address,
  matchPda: Address,
): Promise<ReportResultResult> {
  const [nextMatchPda] = await findMatchPda({
    tournament: tournamentPda,
    round: params.round + 1,
    matchIndex: Math.floor(params.matchIndex / 2),
  });

  const ix = await getReportResultInstructionAsync({
    organizer: signer,
    tournament: tournamentPda,
    matchAccount: matchPda,
    nextMatch: nextMatchPda,
    winner: params.winner,
    placements: [],
  });

  const txSignature = await sendInstructions(client, signer, [ix]);
  return { txSignature, isFinal: false };
}

async function reportFinal(
  client: BracketChainClient,
  params: ReportResultParams,
  signer: ReturnType<typeof assertSigner>,
  tournamentPda: Address,
  matchPda: Address,
  matchAccount: MatchNode,
  tournament: Tournament,
): Promise<ReportResultResult> {
  const placements = params.placements ?? [];
  const expectedCount = getPlacementCount(tournament.payoutPreset);

  if (placements.length !== expectedCount) {
    throw new InvalidPayoutPresetError(
      new Error(
        `placements length ${placements.length} does not match preset's placement_count ${expectedCount}`,
      ),
    );
  }
  if (placements[0] !== params.winner) {
    throw new NonParticipantWinnerError(
      new Error("placements[0] must equal `winner`"),
    );
  }
  if (placements.length >= 2) {
    const runnerUp =
      params.winner === matchAccount.playerA
        ? matchAccount.playerB
        : matchAccount.playerA;
    if (placements[1] !== runnerUp) {
      throw new NonParticipantWinnerError(
        new Error("placements[1] must equal the loser of the final match"),
      );
    }
  }

  // Read protocol_config to get treasury wallet for ATA derivation.
  const [protocolConfigPda] = await findProtocolConfigPda();
  let protocolConfig;
  try {
    protocolConfig = (await fetchProtocolConfig(client.rpc, protocolConfigPda))
      .data;
  } catch (err) {
    throw mapError(err);
  }

  const tokenMint = tournament.tokenMint;

  // Build ATA list: [...placementATAs, treasuryATA] — match on-chain order.
  const placementAtas = await Promise.all(
    placements.map(async (wallet) => {
      const [ata] = await findAssociatedTokenPda({
        owner: wallet,
        mint: tokenMint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      return { wallet, ata };
    }),
  );
  const [treasuryAta] = await findAssociatedTokenPda({
    owner: protocolConfig.treasury,
    mint: tokenMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  // Variant B (R13, ratified 2026-06-05): the organizer deposit stays in the
  // vault and is distributed as part of the prize pool, so the final match
  // needs NO organizer ATA — `organizer_token_account` was removed from the
  // ReportResult accounts entirely.

  // Idempotently create every ATA we depend on (winner placements + treasury).
  const dedupeSet = new Set<Address>();
  const ataInstructions = [];
  for (const { wallet, ata } of placementAtas) {
    if (dedupeSet.has(ata)) continue;
    dedupeSet.add(ata);
    ataInstructions.push(
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: signer,
        owner: wallet,
        mint: tokenMint,
        ata,
      }),
    );
  }
  if (!dedupeSet.has(treasuryAta)) {
    dedupeSet.add(treasuryAta);
    ataInstructions.push(
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: signer,
        owner: protocolConfig.treasury,
        mint: tokenMint,
        ata: treasuryAta,
      }),
    );
  }
  const remainingAccounts: AccountMeta[] = [
    ...placementAtas.map(({ ata }) => ({
      address: ata,
      role: AccountRole.WRITABLE,
    })),
    { address: treasuryAta, role: AccountRole.WRITABLE },
  ];

  const [vaultPda] = await findVaultPda({ tournament: tournamentPda });

  const baseIx = await getReportResultInstructionAsync({
    organizer: signer,
    tournament: tournamentPda,
    matchAccount: matchPda,
    protocolConfig: protocolConfigPda,
    vault: vaultPda,
    winner: params.winner,
    placements,
  });

  const ix: Instruction = {
    ...baseIx,
    accounts: [...(baseIx.accounts ?? []), ...remainingAccounts],
  };

  const txSignature = await sendInstructions(client, signer, [
    ...ataInstructions,
    ix,
  ]);
  return { txSignature, isFinal: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Mirrors `PayoutPreset::placement_count()` — the number of funded placements.
// `Custom` counts its non-zero bps slots.
function getPlacementCount(preset: PayoutPreset): number {
  switch (preset.__kind) {
    case "WinnerTakesAll":
      return 1;
    case "Standard":
      return 3;
    case "Deep":
      return 7;
    case "Custom":
      return preset.fields[0].filter((bps) => bps > 0).length;
    default:
      throw new BracketChainSDKError(
        `Unknown payout preset: ${String((preset as { __kind?: string }).__kind)}`,
        "InvalidArgument",
      );
  }
}

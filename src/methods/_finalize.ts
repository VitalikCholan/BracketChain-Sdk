import {
  AccountRole,
  type AccountMeta,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

import type { BracketChainClient } from "../client";
import {
  BracketChainSDKError,
  InvalidPayoutPresetError,
  NonParticipantWinnerError,
  mapError,
} from "../errors";
import {
  fetchMatchNode,
  fetchProtocolConfig,
  fetchTournament,
  findParticipantPda,
  findProtocolConfigPda,
  PayoutPreset,
  type MatchNode,
  type Tournament,
} from "../generated";
import { findMatchPda } from "../pdas";

/**
 * The shared finalize machinery behind the player-reported settlement
 * instructions (`confirm_result`, `claim_result`, `resolve_dispute`,
 * `force_claim_disputed`). Each of those, like `report_result`, either:
 *  - **advances** the winner into the next-round match (non-final), or
 *  - **distributes** the prize pool per the payout preset (final match), which
 *    requires `placements` + their ATAs in `remaining_accounts`.
 *
 * This helper reads the match + tournament, derives the shared account set
 * (participant PDAs, next-match PDA, organizer ATA), validates `placements`,
 * and builds the idempotent ATA-create instructions + the writable-ATA
 * `remaining_accounts` list. The caller stitches these into its specific
 * generated builder (which carries the per-ix signer + data args).
 */
export interface FinalizeContext {
  isFinal: boolean;
  matchPda: Address;
  matchAccount: MatchNode;
  tournament: Tournament;
  /** Present only for non-final matches. */
  nextMatch?: Address;
  participantA: Address;
  participantB: Address;
  /** Organizer's token ATA — present only for the final match. */
  organizerTokenAccount?: Address;
  /** Idempotent ATA-create instructions to prepend to the tx (final only). */
  ataInstructions: Instruction[];
  /** Writable placement + treasury ATAs to append as remaining accounts. */
  remainingAccounts: AccountMeta[];
}

export interface FinalizeParams {
  tournamentPda: Address;
  round: number;
  matchIndex: number;
  /** Bracket lane (C9). Single-elim V1 = 0. */
  bracket?: number;
  /**
   * The winner being finalized. Omit for confirm/claim/force-claim (defaults to
   * the match's on-chain `proposedWinner`); pass explicitly for resolve_dispute,
   * where the organizer chooses the winner.
   */
  winner?: Address;
  /**
   * Required ONLY on the final match (length must match the preset's
   * placement_count). Empty for non-final matches. Position 0 must equal
   * `winner`; position 1 must be the final's loser.
   */
  placements?: Address[];
  /** The tx fee-payer / ATA-create payer (the instruction's signer). */
  payer: TransactionSigner;
}

export async function buildFinalizeContext(
  client: BracketChainClient,
  params: FinalizeParams,
): Promise<FinalizeContext> {
  const bracket = params.bracket ?? 0;
  const tournamentPda = params.tournamentPda;

  let tournament: Tournament;
  let matchAccount: MatchNode;
  const [matchPda] = await findMatchPda({
    tournament: tournamentPda,
    bracket,
    round: params.round,
    matchIndex: params.matchIndex,
  });
  try {
    tournament = (await fetchTournament(client.rpc, tournamentPda)).data;
    matchAccount = (await fetchMatchNode(client.rpc, matchPda)).data;
  } catch (err) {
    throw mapError(err);
  }

  const [participantA] = await findParticipantPda({
    tournament: tournamentPda,
    player: matchAccount.playerA,
  });
  const [participantB] = await findParticipantPda({
    tournament: tournamentPda,
    player: matchAccount.playerB,
  });

  const winner = params.winner ?? matchAccount.proposedWinner;
  const maxRound = Math.log2(tournament.bracketSize);
  const isFinal = params.round + 1 === maxRound && params.matchIndex === 0;

  if (!isFinal) {
    const [nextMatch] = await findMatchPda({
      tournament: tournamentPda,
      bracket,
      round: params.round + 1,
      matchIndex: Math.floor(params.matchIndex / 2),
    });
    return {
      isFinal: false,
      matchPda,
      matchAccount,
      tournament,
      nextMatch,
      participantA,
      participantB,
      ataInstructions: [],
      remainingAccounts: [],
    };
  }

  // ── final match: validate placements + build ATAs ──────────────────────────
  const placements = params.placements ?? [];
  const expectedCount = getPlacementCount(tournament.payoutPreset);
  if (placements.length !== expectedCount) {
    throw new InvalidPayoutPresetError(
      new Error(
        `placements length ${placements.length} does not match preset's placement_count ${expectedCount}`,
      ),
    );
  }
  if (placements[0] !== winner) {
    throw new NonParticipantWinnerError(
      new Error("placements[0] must equal the winner"),
    );
  }
  if (placements.length >= 2) {
    const loser =
      winner === matchAccount.playerA
        ? matchAccount.playerB
        : matchAccount.playerA;
    if (placements[1] !== loser) {
      throw new NonParticipantWinnerError(
        new Error("placements[1] must equal the loser of the final match"),
      );
    }
  }

  const [protocolConfigPda] = await findProtocolConfigPda();
  let treasury: Address;
  try {
    treasury = (await fetchProtocolConfig(client.rpc, protocolConfigPda)).data
      .treasury;
  } catch (err) {
    throw mapError(err);
  }

  const tokenMint = tournament.tokenMint;
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
    owner: treasury,
    mint: tokenMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [organizerTokenAccount] = await findAssociatedTokenPda({
    owner: tournament.organizer,
    mint: tokenMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const dedupe = new Set<Address>();
  const ataInstructions: Instruction[] = [];
  const ensureAta = async (owner: Address, ata: Address) => {
    if (dedupe.has(ata)) return;
    dedupe.add(ata);
    ataInstructions.push(
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: params.payer,
        owner,
        mint: tokenMint,
        ata,
      }),
    );
  };
  for (const { wallet, ata } of placementAtas) await ensureAta(wallet, ata);
  await ensureAta(treasury, treasuryAta);
  await ensureAta(tournament.organizer, organizerTokenAccount);

  const remainingAccounts: AccountMeta[] = [
    ...placementAtas.map(({ ata }) => ({
      address: ata,
      role: AccountRole.WRITABLE,
    })),
    { address: treasuryAta, role: AccountRole.WRITABLE },
  ];

  return {
    isFinal: true,
    matchPda,
    matchAccount,
    tournament,
    participantA,
    participantB,
    organizerTokenAccount,
    ataInstructions,
    remainingAccounts,
  };
}

export function getPlacementCount(preset: PayoutPreset): number {
  switch (preset) {
    case PayoutPreset.WinnerTakesAll:
      return 1;
    case PayoutPreset.Standard:
      return 3;
    case PayoutPreset.Deep:
      return 7;
    default:
      throw new BracketChainSDKError(
        `Unknown payout preset: ${String(preset)}`,
        "InvalidArgument",
      );
  }
}

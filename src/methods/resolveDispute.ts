import {
  type Address,
  type Instruction,
  type Signature,
} from "@solana/kit";

import type { BracketChainClient } from "../client";
import { getResolveDisputeInstructionAsync } from "../generated";
import { buildFinalizeContext } from "./_finalize";
import { assertSigner, sendInstructions } from "./_send";

export interface ResolveDisputeParams {
  tournamentPda: Address;
  /** 0-indexed round of the match. */
  round: number;
  /** 0-indexed match position within the round. */
  matchIndex: number;
  /** Bracket lane (C9). Single-elim V1 = 0. */
  bracket?: number;
  /** The organizer's chosen winner — must be `playerA` or `playerB`. */
  winner: Address;
  /**
   * Required ONLY on the final match — placements per the payout preset.
   * Position 0 must equal `winner`; position 1 the final's loser.
   */
  placements?: Address[];
}

export interface ResolveDisputeResult {
  txSignature: Signature;
  isFinal: boolean;
}

/**
 * The organizer (acting as arbitrator) settles a disputed match, choosing the
 * winner and finalizing — advancing the bracket (non-final) or distributing the
 * prize pool (final). Signer must be the tournament organizer.
 */
export async function resolveDispute(
  client: BracketChainClient,
  params: ResolveDisputeParams,
): Promise<ResolveDisputeResult> {
  const signer = assertSigner(client, "resolveDispute");
  const ctx = await buildFinalizeContext(client, {
    tournamentPda: params.tournamentPda,
    round: params.round,
    matchIndex: params.matchIndex,
    bracket: params.bracket,
    winner: params.winner,
    placements: params.placements,
    payer: signer,
  });

  const baseIx = await getResolveDisputeInstructionAsync({
    organizer: signer,
    tournament: params.tournamentPda,
    matchAccount: ctx.matchPda,
    nextMatch: ctx.nextMatch,
    participantA: ctx.participantA,
    participantB: ctx.participantB,
    winner: params.winner,
    placements: params.placements ?? [],
  });
  const ix: Instruction = {
    ...baseIx,
    accounts: [...(baseIx.accounts ?? []), ...ctx.remainingAccounts],
  };

  const txSignature = await sendInstructions(client, signer, [
    ...ctx.ataInstructions,
    ix,
  ]);
  return { txSignature, isFinal: ctx.isFinal };
}

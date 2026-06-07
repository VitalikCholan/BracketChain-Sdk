import {
  type Address,
  type Instruction,
  type Signature,
} from "@solana/kit";

import type { BracketChainClient } from "../client";
import { getConfirmResultInstructionAsync } from "../generated";
import { buildFinalizeContext } from "./_finalize";
import { assertSigner, sendInstructions } from "./_send";

export interface ConfirmResultParams {
  tournamentPda: Address;
  /** 0-indexed round of the match. */
  round: number;
  /** 0-indexed match position within the round. */
  matchIndex: number;
  /** Bracket lane (C9). Single-elim V1 = 0. */
  bracket?: number;
  /**
   * Required ONLY on the final match — placements per the payout preset
   * (WTA: 1, Standard: 3, Deep: 7). Position 0 must equal the proposed winner;
   * position 1 the final's loser. Omit for non-final matches.
   */
  placements?: Address[];
}

export interface ConfirmResultResult {
  txSignature: Signature;
  isFinal: boolean;
}

/**
 * The counterparty accepts a pending proposal, finalizing the match for the
 * proposed winner — advancing the bracket (non-final) or distributing the
 * prize pool (final). Signer must be the player who did NOT propose.
 */
export async function confirmResult(
  client: BracketChainClient,
  params: ConfirmResultParams,
): Promise<ConfirmResultResult> {
  const signer = assertSigner(client, "confirmResult");
  const ctx = await buildFinalizeContext(client, {
    tournamentPda: params.tournamentPda,
    round: params.round,
    matchIndex: params.matchIndex,
    bracket: params.bracket,
    placements: params.placements,
    payer: signer,
  });

  const baseIx = await getConfirmResultInstructionAsync({
    counterparty: signer,
    tournament: params.tournamentPda,
    matchAccount: ctx.matchPda,
    nextMatch: ctx.nextMatch,
    participantA: ctx.participantA,
    participantB: ctx.participantB,
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

import {
  type Address,
  type Instruction,
  type Signature,
} from "@solana/kit";

import type { BracketChainClient } from "../client";
import { getClaimResultInstructionAsync } from "../generated";
import { buildFinalizeContext } from "./_finalize";
import { assertSigner, sendInstructions } from "./_send";

export interface ClaimResultParams {
  tournamentPda: Address;
  /** 0-indexed round of the match. */
  round: number;
  /** 0-indexed match position within the round. */
  matchIndex: number;
  /** Bracket lane (C9). Single-elim V1 = 0. */
  bracket?: number;
  /**
   * Required ONLY on the final match — placements per the payout preset.
   * Position 0 must equal the proposed winner; position 1 the final's loser.
   */
  placements?: Address[];
}

export interface ClaimResultResult {
  txSignature: Signature;
  isFinal: boolean;
}

/**
 * Permissionless: finalize an undisputed proposal once its dispute window has
 * elapsed (`now >= claim_deadline && !disputed`). Typically driven by the
 * `auto-claim` cron (signed by `claim-payer`); anyone may call it.
 */
export async function claimResult(
  client: BracketChainClient,
  params: ClaimResultParams,
): Promise<ClaimResultResult> {
  const signer = assertSigner(client, "claimResult");
  const ctx = await buildFinalizeContext(client, {
    tournamentPda: params.tournamentPda,
    round: params.round,
    matchIndex: params.matchIndex,
    bracket: params.bracket,
    placements: params.placements,
    payer: signer,
  });

  const baseIx = await getClaimResultInstructionAsync({
    payer: signer,
    tournament: params.tournamentPda,
    matchAccount: ctx.matchPda,
    nextMatch: ctx.nextMatch,
    participantA: ctx.participantA,
    participantB: ctx.participantB,
    organizerTokenAccount: ctx.organizerTokenAccount,
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

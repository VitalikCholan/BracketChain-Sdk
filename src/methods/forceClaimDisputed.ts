import {
  type Address,
  type Instruction,
  type Signature,
} from "@solana/kit";

import type { BracketChainClient } from "../client";
import { getForceClaimDisputedInstructionAsync } from "../generated";
import { buildFinalizeContext } from "./_finalize";
import { assertSigner, sendInstructions } from "./_send";

export interface ForceClaimDisputedParams {
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

export interface ForceClaimDisputedResult {
  txSignature: Signature;
  isFinal: boolean;
}

/**
 * Permissionless escape hatch: finalize a DISPUTED match for its proposed
 * winner once the 24h force-claim window has elapsed and the organizer has not
 * resolved it. Prevents an absent organizer from stalling the bracket forever.
 */
export async function forceClaimDisputed(
  client: BracketChainClient,
  params: ForceClaimDisputedParams,
): Promise<ForceClaimDisputedResult> {
  const signer = assertSigner(client, "forceClaimDisputed");
  const ctx = await buildFinalizeContext(client, {
    tournamentPda: params.tournamentPda,
    round: params.round,
    matchIndex: params.matchIndex,
    bracket: params.bracket,
    placements: params.placements,
    payer: signer,
  });

  const baseIx = await getForceClaimDisputedInstructionAsync({
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

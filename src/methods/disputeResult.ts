import { type Address, type Signature } from "@solana/kit";

import type { BracketChainClient } from "../client";
import { getDisputeResultInstruction } from "../generated";
import { findMatchPda } from "../pdas";
import { assertSigner, sendInstructions } from "./_send";

export interface DisputeResultParams {
  tournamentPda: Address;
  /** 0-indexed round of the match. */
  round: number;
  /** 0-indexed match position within the round. */
  matchIndex: number;
  /** Bracket lane (C9). Single-elim V1 = 0. */
  bracket?: number;
  /**
   * Free-form reason code (u8) recorded on-chain for the dispute. Indexer /
   * frontend map this to a human-readable label.
   */
  disputeReason?: number;
}

export interface DisputeResultResult {
  txSignature: Signature;
}

/**
 * The counterparty disputes a pending proposal, flagging the match for
 * organizer resolution. Re-arms `claim_deadline` to +24h: if the organizer
 * stays silent, anyone may `forceClaimDisputed` after the window.
 *
 * Generic over proposal source — for `Oracle` matches either player (or the
 * arbitrator) may dispute (Stage C broadens the signer rule).
 */
export async function disputeResult(
  client: BracketChainClient,
  params: DisputeResultParams,
): Promise<DisputeResultResult> {
  const signer = assertSigner(client, "disputeResult");
  const [matchPda] = await findMatchPda({
    tournament: params.tournamentPda,
    bracket: params.bracket ?? 0,
    round: params.round,
    matchIndex: params.matchIndex,
  });

  const ix = getDisputeResultInstruction({
    disputer: signer,
    tournament: params.tournamentPda,
    matchAccount: matchPda,
    disputeReason: params.disputeReason ?? 0,
  });

  const txSignature = await sendInstructions(client, signer, [ix]);
  return { txSignature };
}

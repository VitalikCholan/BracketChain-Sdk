import { type Address, type Signature } from "@solana/kit";

import type { BracketChainClient } from "../client";
import { getProposeResultInstruction } from "../generated";
import { findMatchPda } from "../pdas";
import { assertSigner, sendInstructions } from "./_send";

export interface ProposeResultParams {
  tournamentPda: Address;
  /** 0-indexed round of the match. */
  round: number;
  /** 0-indexed match position within the round. */
  matchIndex: number;
  /** Bracket lane (C9). Single-elim V1 = 0. */
  bracket?: number;
  /** Proposed winner — must be `playerA` or `playerB` on the match. */
  proposedWinner: Address;
}

export interface ProposeResultResult {
  txSignature: Signature;
}

/**
 * A player (`playerA` or `playerB`) proposes a match result, opening the
 * dispute window. The counterparty may then `confirmResult` or `disputeResult`;
 * if neither happens by `claim_deadline`, anyone may `claimResult`.
 *
 * Only valid for `PlayerReported` tournaments — `OrganizerOnly` rejects it.
 */
export async function proposeResult(
  client: BracketChainClient,
  params: ProposeResultParams,
): Promise<ProposeResultResult> {
  const signer = assertSigner(client, "proposeResult");
  const [matchPda] = await findMatchPda({
    tournament: params.tournamentPda,
    bracket: params.bracket ?? 0,
    round: params.round,
    matchIndex: params.matchIndex,
  });

  const ix = getProposeResultInstruction({
    proposer: signer,
    tournament: params.tournamentPda,
    matchAccount: matchPda,
    proposedWinner: params.proposedWinner,
  });

  const txSignature = await sendInstructions(client, signer, [ix]);
  return { txSignature };
}

import { type Address, type Signature } from "@solana/kit";

import type { BracketChainClient } from "../client";
import { getProposeResultOracleInstructionAsync } from "../generated";
import { findMatchPda } from "../pdas";
import { assertSigner, sendInstructions } from "./_send";

export interface ProposeResultOracleParams {
  tournamentPda: Address;
  /** 0-indexed round of the match. */
  round: number;
  /** 0-indexed match position within the round. */
  matchIndex: number;
  /** Bracket lane (C9). Single-elim V1 = 0. */
  bracket?: number;
  /** Switchboard On-Demand feed account bound to this match. */
  switchboardFeed: Address;
}

export interface ProposeResultOracleResult {
  txSignature: Signature;
}

/**
 * Permissionless oracle relayer (V1.2): writes the Switchboard-reported winner
 * into the match proposal envelope with `source = Oracle`. Trust bottoms out
 * in the feed account contents — the program verifies the feed hash against
 * `Match.expectedFeedHash` committed earlier via `commitMatchLobby` /
 * `bindMatchFeed`.
 *
 * Only valid on Oracle-mode tournaments with a feed bound to the match.
 */
export async function proposeResultOracle(
  client: BracketChainClient,
  params: ProposeResultOracleParams,
): Promise<ProposeResultOracleResult> {
  const signer = assertSigner(client, "proposeResultOracle");
  const [matchPda] = await findMatchPda({
    tournament: params.tournamentPda,
    bracket: params.bracket ?? 0,
    round: params.round,
    matchIndex: params.matchIndex,
  });

  const ix = await getProposeResultOracleInstructionAsync({
    relayer: signer,
    tournament: params.tournamentPda,
    matchAccount: matchPda,
    switchboardFeed: params.switchboardFeed,
  });

  const txSignature = await sendInstructions(client, signer, [ix]);
  return { txSignature };
}

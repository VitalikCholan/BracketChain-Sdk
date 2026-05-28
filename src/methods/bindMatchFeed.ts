import { type Address, type Signature } from "@solana/kit";

import type { BracketChainClient } from "../client";
import { getBindMatchFeedInstructionAsync } from "../generated";
import { findMatchPda } from "../pdas";
import { assertSigner, sendInstructions } from "./_send";

export interface BindMatchFeedParams {
  tournamentPda: Address;
  /** 0-indexed round of the match. */
  round: number;
  /** 0-indexed match position within the round. */
  matchIndex: number;
  /** Bracket lane (C9). Single-elim V1 = 0. */
  bracket?: number;
  /**
   * Switchboard PullFeed account address. Its `PullFeedAccountData.queue`
   * must equal `protocol_config.switchboard_queue`, and the feed hash must
   * match `Match.expectedFeedHash` set by `commitMatchLobby`.
   */
  switchboardFeed: Address;
}

export interface BindMatchFeedResult {
  txSignature: Signature;
}

/**
 * Organizer (Stage C / V1.2): bind a Switchboard PullFeed to a previously
 * committed match. Must be called after `commitMatchLobby` and before the
 * relayer can call `proposeResultOracle`.
 */
export async function bindMatchFeed(
  client: BracketChainClient,
  params: BindMatchFeedParams,
): Promise<BindMatchFeedResult> {
  const signer = assertSigner(client, "bindMatchFeed");
  const [matchPda] = await findMatchPda({
    tournament: params.tournamentPda,
    bracket: params.bracket ?? 0,
    round: params.round,
    matchIndex: params.matchIndex,
  });

  const ix = await getBindMatchFeedInstructionAsync({
    organizer: signer,
    tournament: params.tournamentPda,
    matchAccount: matchPda,
    switchboardFeed: params.switchboardFeed,
  });

  const txSignature = await sendInstructions(client, signer, [ix]);
  return { txSignature };
}

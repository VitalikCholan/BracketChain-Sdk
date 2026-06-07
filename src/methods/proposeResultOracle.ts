import {
  type Address,
  type AddressesByLookupTableAddress,
  type Instruction,
  type Signature,
} from "@solana/kit";

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
  /**
   * Instructions to run **before** `propose_result_oracle` in the SAME
   * transaction. The relayer cron bundles Switchboard's feed-update (crank)
   * instructions here so the freshly-landed oracle value is read in the slot
   * it lands — the same "same-slot" pattern as `revealSeed`. Without an
   * update in-tx, the read must beat `max_stale_slots` on its own.
   */
  preInstructions?: Instruction[];
  /**
   * Address-lookup tables for the bundled pre-instructions (Switchboard's
   * `fetchUpdateIx` returns them) — required to fit the update + propose
   * combo under the packet-size limit.
   */
  lookupTables?: AddressesByLookupTableAddress;
  /**
   * Explicit compute-unit limit. The bundled feed update (secp256k1 oracle
   * signature verification) far exceeds the 200k default that would
   * otherwise apply; the relayer passes a generous limit.
   */
  computeUnits?: number;
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

  const txSignature = await sendInstructions(
    client,
    signer,
    [...(params.preInstructions ?? []), ix],
    {
      computeUnits: params.computeUnits,
      lookupTables: params.lookupTables,
    },
  );
  return { txSignature };
}

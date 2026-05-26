import {
  type Address,
  type Instruction,
  type Signature,
} from "@solana/kit";

import type { BracketChainClient } from "../client";
import { getRevealSeedInstruction } from "../generated";
import { assertSigner, sendInstructions } from "./_send";

export interface RevealSeedParams {
  tournamentPda: Address;
  /** The bound Switchboard randomness account (matches `requestSeed`). */
  randomnessAccount: Address;
  /**
   * Instructions to run **before** `reveal_seed` in the SAME transaction.
   * Switchboard On-Demand only exposes the revealed value in the slot it is
   * revealed, so the VRF-reveal cron must bundle Switchboard's own reveal
   * instruction here, ahead of `reveal_seed`.
   */
  preInstructions?: Instruction[];
}

export interface RevealSeedResult {
  txSignature: Signature;
}

/**
 * Permissionless: read the bound Switchboard randomness value and write
 * `tournament.seed_hash`, flipping `seed_revealed`. Typically driven by the
 * `vrf-reveal` cron (signed by `vrf-payer`), bundling Switchboard's reveal
 * instruction via `preInstructions`.
 */
export async function revealSeed(
  client: BracketChainClient,
  params: RevealSeedParams,
): Promise<RevealSeedResult> {
  const signer = assertSigner(client, "revealSeed");

  const ix = getRevealSeedInstruction({
    payer: signer,
    tournament: params.tournamentPda,
    randomnessAccount: params.randomnessAccount,
  });

  const txSignature = await sendInstructions(client, signer, [
    ...(params.preInstructions ?? []),
    ix,
  ]);
  return { txSignature };
}

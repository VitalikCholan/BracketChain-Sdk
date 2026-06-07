import { type Address, type Signature } from "@solana/kit";

import type { BracketChainClient } from "../client";
import { getRequestSeedInstruction } from "../generated";
import { assertSigner, sendInstructions } from "./_send";

export interface RequestSeedParams {
  tournamentPda: Address;
  /**
   * The committed Switchboard On-Demand randomness account. Create + commit it
   * client-side first (Switchboard SDK `Randomness.create` + `commitIx`); this
   * instruction binds it to the tournament. The reveal happens later via
   * `revealSeed` (permissionless cron), in the same slot Switchboard reveals.
   */
  randomnessAccount: Address;
}

export interface RequestSeedResult {
  txSignature: Signature;
}

/**
 * Organizer binds a committed Switchboard randomness account to the tournament,
 * recording `vrf_randomness_account` + `vrf_commit_slot`. Gates verifiable
 * bracket seeding: once bound, `start_tournament` requires `seed_revealed`.
 */
export async function requestSeed(
  client: BracketChainClient,
  params: RequestSeedParams,
): Promise<RequestSeedResult> {
  const signer = assertSigner(client, "requestSeed");

  const ix = getRequestSeedInstruction({
    organizer: signer,
    tournament: params.tournamentPda,
    randomnessAccount: params.randomnessAccount,
  });

  const txSignature = await sendInstructions(client, signer, [ix]);
  return { txSignature };
}

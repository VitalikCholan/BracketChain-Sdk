import { type Address, type Signature } from "@solana/kit";

import type { BracketChainClient } from "../client";
import { getSetOracleConfigInstructionAsync } from "../generated";
import { assertSigner, sendInstructions } from "./_send";

export interface SetOracleConfigParams {
  /** Switchboard On-Demand queue all bound feeds must originate from. */
  switchboardQueue: Address;
  /** Maximum feed staleness (slots) accepted by `proposeResultOracle`. */
  maxStaleSlots: number;
  /** Minimum oracle sample count required on the feed. */
  minOracleSamples: number;
}

export interface SetOracleConfigResult {
  txSignature: Signature;
}

/**
 * Admin (Stage C / V1.2): set Switchboard On-Demand settlement params on the
 * protocol config. Signer must be the authority recorded in `ProtocolConfig`.
 */
export async function setOracleConfig(
  client: BracketChainClient,
  params: SetOracleConfigParams,
): Promise<SetOracleConfigResult> {
  const signer = assertSigner(client, "setOracleConfig");

  const ix = await getSetOracleConfigInstructionAsync({
    authority: signer,
    switchboardQueue: params.switchboardQueue,
    maxStaleSlots: params.maxStaleSlots,
    minOracleSamples: params.minOracleSamples,
  });

  const txSignature = await sendInstructions(client, signer, [ix]);
  return { txSignature };
}

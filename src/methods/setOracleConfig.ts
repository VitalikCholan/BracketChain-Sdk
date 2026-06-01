import { type Address, type Signature } from "@solana/kit";

import type { BracketChainClient } from "../client";
import { BracketChainSDKError } from "../errors";
import { getSetOracleConfigInstructionAsync } from "../generated";
import { assertSigner, sendInstructions } from "./_send";

// Mirrors the on-chain bounds in `constants.rs` (L-2). Kept in sync so callers
// fail fast with a clear message instead of a rejected tx (`InvalidOracleConfig`).
const MIN_ORACLE_SAMPLES_FLOOR = 1;
const MAX_ORACLE_STALE_SLOTS_CEILING = 9_000;

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

  if (
    !Number.isInteger(params.minOracleSamples) ||
    params.minOracleSamples < MIN_ORACLE_SAMPLES_FLOOR
  ) {
    throw new BracketChainSDKError(
      `minOracleSamples must be an integer >= ${MIN_ORACLE_SAMPLES_FLOOR} (0 would let a single oracle sample settle a match)`,
      "InvalidOracleConfig",
    );
  }
  if (
    !Number.isInteger(params.maxStaleSlots) ||
    params.maxStaleSlots < 0 ||
    params.maxStaleSlots > MAX_ORACLE_STALE_SLOTS_CEILING
  ) {
    throw new BracketChainSDKError(
      `maxStaleSlots must be an integer in [0, ${MAX_ORACLE_STALE_SLOTS_CEILING}]`,
      "InvalidOracleConfig",
    );
  }

  const ix = await getSetOracleConfigInstructionAsync({
    authority: signer,
    switchboardQueue: params.switchboardQueue,
    maxStaleSlots: params.maxStaleSlots,
    minOracleSamples: params.minOracleSamples,
  });

  const txSignature = await sendInstructions(client, signer, [ix]);
  return { txSignature };
}

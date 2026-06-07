import {
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type AddressesByLookupTableAddress,
  type Instruction,
  type Signature,
  type TransactionSigner,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";

import type { BracketChainClient } from "../client";
import { BracketChainSDKError, mapError } from "../errors";

export interface SendOptions {
  /**
   * Compute-unit limit for this tx. Prepended as a SetComputeUnitLimit
   * instruction when provided.
   */
  computeUnits?: number;
  /**
   * Address-lookup tables to compress the v0 message with
   * (`{ [lutAddress]: addresses[] }`). Needed when bundled pre-instructions
   * (e.g. a Switchboard feed update) reference more accounts than fit in the
   * 1232-byte packet uncompressed. No-op when empty.
   */
  lookupTables?: AddressesByLookupTableAddress;
}

/**
 * Throw a clean `ReadOnlyClient` error when the SDK is asked to mutate
 * without a signer. Returns the signer when present so call sites get a
 * non-null reference.
 */
export function assertSigner(
  client: BracketChainClient,
  method: string,
): TransactionSigner {
  if (!client.signer) {
    throw new BracketChainSDKError(
      `${method} requires a signer — pass \`signer\` to BracketChainClient.`,
      "ReadOnlyClient",
    );
  }
  return client.signer;
}

/**
 * Compose, sign, send, and confirm a transaction. Returns the tx signature.
 *
 * Requires `client.rpcSubscriptions` to wait for confirmation. Errors are
 * routed through `mapError` so SDK consumers always receive typed
 * `BracketChainSDKError` subclasses.
 */
export async function sendInstructions(
  client: BracketChainClient,
  payer: TransactionSigner,
  instructions: readonly Instruction[],
  opts: SendOptions = {},
): Promise<Signature> {
  if (!client.rpcSubscriptions) {
    throw new BracketChainSDKError(
      "Sending transactions requires `rpcSubscriptions` — pass it to BracketChainClient.",
      "MissingRpcSubscriptions",
    );
  }

  const ixs: Instruction[] =
    opts.computeUnits !== undefined
      ? [
          getSetComputeUnitLimitInstruction({ units: opts.computeUnits }),
          ...instructions,
        ]
      : [...instructions];

  try {
    const { value: latestBlockhash } = await client.rpc
      .getLatestBlockhash({ commitment: client.commitment })
      .send();

    const lookupTables = opts.lookupTables ?? {};
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
      (m) =>
        Object.keys(lookupTables).length > 0
          ? compressTransactionMessageUsingAddressLookupTables(m, lookupTables)
          : m,
    );

    const signedTx = await signTransactionMessageWithSigners(message);

    // Cluster-typed factory — Kit ships overloads for devnet/testnet/mainnet
    // only. Our SDK is cluster-agnostic, so we cast through `any` for the
    // factory call. The runtime contract is identical across clusters.
    const sendAndConfirm = sendAndConfirmTransactionFactory({
      rpc: client.rpc,
      rpcSubscriptions: client.rpcSubscriptions,
    } as Parameters<typeof sendAndConfirmTransactionFactory>[0]);

    await sendAndConfirm(
      signedTx as Parameters<typeof sendAndConfirm>[0],
      { commitment: client.commitment },
    );
    return getSignatureFromTransaction(signedTx);
  } catch (err) {
    throw mapError(err);
  }
}

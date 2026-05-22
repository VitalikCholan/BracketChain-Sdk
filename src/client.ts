import {
  address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  type Address,
  type Commitment,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type TransactionSigner,
} from "@solana/kit";

import { BRACKET_CHAIN_PROGRAM_ADDRESS } from "./generated";

export interface BracketChainClientOptions {
  /**
   * Either a Kit `Rpc<SolanaRpcApi>` instance, or an RPC endpoint URL the
   * client will wrap with `createSolanaRpc`. Cluster choice is the caller's
   * responsibility.
   */
  rpc: Rpc<SolanaRpcApi> | string;
  /**
   * Optional Kit RPC subscriptions instance (or a WS endpoint URL). Required
   * by `subscribe()`; reads + writes work without it.
   */
  rpcSubscriptions?: RpcSubscriptions<SolanaRpcSubscriptionsApi> | string;
  /**
   * Wallet for signing transactions. If omitted, the client is read-only —
   * mutating methods (createTournament, joinTournament, etc.) will throw at
   * runtime with a clear message.
   *
   * In a frontend, wrap your wallet-adapter into a `TransactionSigner` via
   * `@solana/react`. In a Node script, use `createSignerFromKeyPair`.
   */
  signer?: TransactionSigner;
  /** Override the program address. Defaults to BRACKET_CHAIN_PROGRAM_ADDRESS. */
  programAddress?: Address;
  /** Commitment level used for both reads and writes. Default: "confirmed". */
  commitment?: Commitment;
}

/**
 * High-level client for the BracketChain on-chain program.
 *
 * @example
 * ```ts
 * import { BracketChainClient } from "@bracketchain/sdk";
 *
 * const client = new BracketChainClient({
 *   rpc: "https://api.devnet.solana.com",
 *   rpcSubscriptions: "wss://api.devnet.solana.com",
 * });
 *
 * const tournaments = await client.listTournaments();
 * ```
 */
export class BracketChainClient {
  public readonly rpc: Rpc<SolanaRpcApi>;
  public readonly rpcSubscriptions?: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  public readonly signer?: TransactionSigner;
  public readonly programAddress: Address;
  public readonly commitment: Commitment;

  constructor(opts: BracketChainClientOptions) {
    this.rpc = typeof opts.rpc === "string" ? createSolanaRpc(opts.rpc) : opts.rpc;
    this.rpcSubscriptions =
      typeof opts.rpcSubscriptions === "string"
        ? createSolanaRpcSubscriptions(opts.rpcSubscriptions)
        : opts.rpcSubscriptions;
    this.signer = opts.signer;
    this.programAddress =
      opts.programAddress ?? address(BRACKET_CHAIN_PROGRAM_ADDRESS);
    this.commitment = opts.commitment ?? "confirmed";
  }

  /** True if a signer is attached and mutations are allowed. */
  public get canSign(): boolean {
    return this.signer !== undefined;
  }
}

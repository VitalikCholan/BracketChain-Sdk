import type { Address, Commitment } from "@solana/kit";

import type { BracketChainClient } from "../client";
import { BracketChainSDKError } from "../errors";
import {
  getMatchNodeDecoder,
  getTournamentDecoder,
  type MatchNode,
  type Tournament,
} from "../generated";

/**
 * Event emitted by {@link subscribe} when an account changes on-chain.
 *
 * Discriminated by `kind` so consumers can narrow on a single union type.
 */
export type TournamentSubscriptionEvent =
  | {
      kind: "tournament";
      address: Address;
      account: Tournament;
    }
  | {
      kind: "match";
      address: Address;
      account: MatchNode;
    };

export interface SubscribeOptions {
  /**
   * MatchNode PDAs to watch alongside the tournament. The web app typically
   * passes the current round's active matches.
   */
  matchPdas?: Address[];
  /**
   * Commitment for account-change deliveries. Defaults to the client's
   * commitment.
   */
  commitment?: Commitment;
  /**
   * Invoked when the underlying notification stream errors or a decode fails.
   * Consumers can plug their own resub strategy here.
   */
  onError?: (err: SubscriptionError) => void;
}

/** Typed error surface for subscribe() callbacks. */
export interface SubscriptionError {
  /** Address whose handler threw, or `null` for connection-level errors. */
  address: Address | null;
  /** Underlying error or message. */
  cause: unknown;
  /** Subscription kind that errored — useful for selective resub. */
  kind: "tournament" | "match" | "connection";
}

/**
 * Live-subscribe to a tournament's on-chain state via Kit RPC subscriptions.
 *
 * The callback fires whenever the Tournament PDA or any of the supplied
 * MatchNode PDAs changes.
 *
 * @returns an unsubscribe fn that aborts every underlying subscription this
 *   call registered. Idempotent — safe to call multiple times.
 */
export function subscribe(
  client: BracketChainClient,
  tournamentPda: Address,
  callback: (event: TournamentSubscriptionEvent) => void,
  options: SubscribeOptions = {},
): () => void {
  if (!client.rpcSubscriptions) {
    throw new BracketChainSDKError(
      "subscribe() requires `rpcSubscriptions` — pass it to BracketChainClient.",
      "MissingRpcSubscriptions",
    );
  }

  const abortController = new AbortController();
  const commitment = options.commitment ?? client.commitment;
  const onError = options.onError;

  void runSubscription(
    client,
    tournamentPda,
    "tournament",
    abortController.signal,
    commitment,
    (account) => callback({ kind: "tournament", address: tournamentPda, account }),
    onError,
  );

  for (const matchPda of options.matchPdas ?? []) {
    void runSubscription(
      client,
      matchPda,
      "match",
      abortController.signal,
      commitment,
      (account) => callback({ kind: "match", address: matchPda, account }),
      onError,
    );
  }

  let torn = false;
  return () => {
    if (torn) return;
    torn = true;
    abortController.abort();
  };
}

async function runSubscription<TKind extends "tournament" | "match">(
  client: BracketChainClient,
  address: Address,
  kind: TKind,
  abortSignal: AbortSignal,
  commitment: Commitment,
  emit: (account: TKind extends "tournament" ? Tournament : MatchNode) => void,
  onError: ((err: SubscriptionError) => void) | undefined,
): Promise<void> {
  // Non-null asserted: subscribe() throws if rpcSubscriptions is missing.
  const rpcSubscriptions = client.rpcSubscriptions!;
  const decoder =
    kind === "tournament" ? getTournamentDecoder() : getMatchNodeDecoder();

  try {
    const notifications = await rpcSubscriptions
      .accountNotifications(address, { encoding: "base64", commitment })
      .subscribe({ abortSignal });

    for await (const notification of notifications) {
      try {
        const [base64Str] = notification.value.data;
        const binary = atob(base64Str);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const account = decoder.decode(bytes) as TKind extends "tournament"
          ? Tournament
          : MatchNode;
        emit(account);
      } catch (err) {
        if (onError) onError({ address, cause: err, kind });
      }
    }
  } catch (err) {
    if (abortSignal.aborted) return;
    if (onError) onError({ address: null, cause: err, kind: "connection" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SDK indexer client. Phase 5.1 foundation for the indexer-first read path.
//
// This module mirrors what frontend code was doing inline via `fetch()` —
// surfaces it through `@bracketchain/sdk` so both the web app and external
// game-developer integrations can read indexed tournament data without
// reaching into a private REST surface.
//
// Design notes:
//  - Plain fetch + AbortSignal — no extra runtime dependencies. Works in
//    Node 18+ and modern browsers (globalThis.fetch).
//  - BigInt fields arrive over the wire as decimal strings (Postgres BIGINT
//    serialized via the indexer's BigInt-aware controller). We keep them as
//    strings here; consumers that need arithmetic should `BigInt(value)`.
//  - The client carries no SDK chain state (no Connection, no Wallet) — it
//    is intentionally orthogonal to BracketChainClient. Phase 5.3 will
//    wire SWR composition between the two.
// ─────────────────────────────────────────────────────────────────────────────

import { BracketChainSDKError } from "./errors";

export type IndexerTournamentStatus =
  | "Registration"
  | "PendingBracketInit"
  | "Active"
  | "Completed"
  | "Cancelled"
  | "PartialCancelled";

export type IndexerPayoutPreset = "WinnerTakesAll" | "Standard" | "Deep";

export type IndexerPayoutKind = "Prize" | "Refund" | "Fee" | "OrganizerRefund";

/**
 * Match lifecycle as served by the indexer. Pending/Active/Completed come
 * straight from chain; PendingConfirmation/Disputed are derived by the parser
 * from the settlement envelope (Stage B). The on-chain `MatchNode.status` only
 * has the three base states — the two intermediate states live purely in the
 * indexer's read model, so consumers mapping back to the chain `MatchNode`
 * shape must collapse them to `Active` and read the envelope for the UI state.
 */
export type IndexerMatchStatus =
  | "Pending"
  | "Active"
  | "PendingConfirmation"
  | "Disputed"
  | "Completed";

/** On-chain `SettlementMode` as served by the indexer. */
export type IndexerSettlementMode =
  | "OrganizerOnly"
  | "PlayerReported"
  | "Oracle";

/** On-chain `SupportedGame` as served by the indexer. */
export type IndexerGame =
  | "Manual"
  | "Dota2"
  | "Cs2Faceit"
  | "Valorant"
  | "LoL";

/** Source of a match-result proposal, mirroring the on-chain `ProposalSource`. */
export type IndexerProposalSource =
  | "None"
  | "Player"
  | "Oracle"
  | "GameServer";

export interface IndexerTournament {
  address: string;
  organizer: string;
  name: string;
  /** SPL Token mint address (base58). Mint-agnostic — was renamed from `usdcMint` 2026-05-03. */
  tokenMint: string;
  /** Entry fee in token base units. Decimal string to preserve u64 precision. */
  entryFee: string;
  /** Phase 2.5: optional organizer top-up (Variant B — distributed via preset on completion, refunded on cancel). */
  organizerDeposit: string;
  maxParticipants: number;
  payoutPreset: IndexerPayoutPreset;
  registrationDeadline: string;
  status: IndexerTournamentStatus;
  /**
   * On-chain settlement mode (who may report results). Not carried by any
   * event — the reconciliation cron backfills it set-once from chain, so it is
   * `null` only on freshly-indexed rows before the first reconcile (always
   * populated well before a tournament is Active). Frontend uses this to pick
   * the result flow: organizer-report vs player-reported.
   */
  settlementMode: IndexerSettlementMode | null;
  /**
   * On-chain game (V1.1). Like `settlementMode`, carried by no event and
   * backfilled set-once from chain by the reconciliation cron — `null` only on
   * freshly-indexed rows before the first reconcile. Frontend treats `null` as
   * `Manual` and uses this to gate the Steam-link requirement on join (A-11).
   */
  game: IndexerGame | null;
  champion: string | null;
  grossPool: string | null;
  feeAmount: string | null;
  netPool: string | null;
  createdAt: string;
  completedAt: string | null;
  createdTxSig: string;
  completedTxSig: string | null;
  /**
   * Phase 5.1: Solana slot of the most recent webhook-driven write.
   * Used by SWR freshness gating (Phase 5.3). Decimal string. "0" on legacy
   * rows seeded before 5.1 — treat as fully stale and reconcile from chain.
   */
  chainSlotAtWrite: string;
  /**
   * Stage C (V1.2 Oracle): wallet authorized to resolve disputed oracle
   * proposals. Defaults to the organizer at create-time; Squads reassignment
   * deferred to V1.3. Null on pre-V1.2 rows that haven't been reconciled yet.
   */
  arbitrator: string | null;
  /**
   * Live participant count from the indexer DB (Participant table row count,
   * excluding cancelled/refunded participants). Absent on responses from indexer
   * versions prior to this field — treat undefined as 0.
   */
  participantCount?: number;
}

export interface IndexerPayout {
  id: string;
  tournamentAddress: string;
  recipient: string;
  amount: string;
  kind: IndexerPayoutKind;
  placement: number | null;
  txSignature: string;
  createdAt: string;
}

/** Phase 5.2: per-tournament participant cache. */
export interface IndexerParticipant {
  id: string;
  tournamentAddress: string;
  wallet: string;
  /** Program-assigned slot for bracket seeding (0-indexed). */
  seedIndex: number;
  /** True after RefundIssued for this wallet (entry-fee refund only). */
  refundPaid: boolean;
  registeredAt: string;
  registeredTxSig: string;
  chainSlotAtWrite: string;
  /**
   * B-14 (Stage B): foundation stats + game identity, mirroring the on-chain
   * Participant account. No current event carries these — the reconciliation
   * cron backfills them from chain, so they read `0` / `null` until then.
   */
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  /** SAS attestation identity bytes (hex) — SHA-256(steam_id_64 LE), stored verbatim; null for Manual games. */
  identityHash: string | null;
}

/**
 * Phase 5.2: per-tournament match cache.
 * Currently populated only from MatchReported events — `playerA`, `playerB`, `bye`
 * are filled by Phase 5.4 reconciliation cron from on-chain MatchNode state.
 * Until then, frontend SWR layer falls back to RPC for unreported matches.
 */
export interface IndexerMatch {
  id: string;
  tournamentAddress: string;
  /**
   * B-14 (C9): bracket lane — `0` for single-elimination (V1). Part of the
   * on-chain MatchNode PDA seed and this row's natural key.
   */
  bracket: number;
  round: number;
  matchIndex: number;
  playerA: string | null;
  playerB: string | null;
  winner: string | null;
  status: IndexerMatchStatus;
  bye: boolean;
  reportedAt: string | null;
  reportedTxSig: string | null;
  chainSlotAtWrite: string;
  /**
   * B-14 (Stage B): player-reported / oracle settlement envelope, mirroring
   * the on-chain MatchNode fields. `status` carries the derived UI state
   * (PendingConfirmation / Disputed / Completed); these hold the underlying
   * envelope the frontend reads to render confirm/dispute panels and the
   * auto-claim / vrf crons scan. Empty (`None` / null / false) on matches with
   * no live proposal.
   */
  proposalSource: IndexerProposalSource;
  proposer: string | null;
  proposedWinner: string | null;
  proposedAt: string | null;
  /**
   * ISO time after which the result may be permissionlessly finalized. On
   * dispute it is re-armed to the +24h force-claim window. Null when no
   * proposal is live.
   */
  claimDeadline: string | null;
  disputed: boolean;
  /** Raw `dispute_reason` code (u8) from the ResultDisputed event; null when undisputed. */
  disputeReason: number | null;
  /**
   * Stage C (V1.2 Oracle settlement) — `MatchCommitment` snapshot. All null on
   * OrganizerOnly / PlayerReported matches and on Oracle matches before the
   * commit/bind ceremony has begun. Byte fields serialize as lowercase hex.
   * `lobbyId` + `committedAt` populate when `MatchLobbyCommitted` fires;
   * `switchboardFeed` populates when `MatchFeedBound` fires; the game-id
   * fields + `expectedFeedHash` are backfilled from chain by the reconciliation
   * cron (audit + frontend OraclePendingPanel display).
   */
  lobbyId: string | null;
  playerAGameId: string | null;
  playerBGameId: string | null;
  expectedFeedHash: string | null;
  committedAt: string | null;
  switchboardFeed: string | null;
}

export interface IndexerClientOptions {
  /** Indexer base URL, e.g. `https://bracketchain-indexer-production.up.railway.app`. */
  baseUrl: string;
  /**
   * Optional fetch implementation. Defaults to globalThis.fetch. Provided
   * primarily for tests and edge-runtime environments that need a custom
   * fetch (e.g. Cloudflare Workers, Deno).
   */
  fetch?: typeof fetch;
}

export interface ListTournamentsOptions {
  status?: IndexerTournamentStatus;
  limit?: number;
  signal?: AbortSignal;
}

export interface GetPayoutsOptions {
  signal?: AbortSignal;
}

export interface GetParticipantsOptions {
  signal?: AbortSignal;
}

export interface GetMatchesOptions {
  signal?: AbortSignal;
}

/**
 * Typed client for the BracketChain indexer REST API.
 *
 * @example
 * ```ts
 * const indexer = new BracketChainIndexerClient({
 *   baseUrl: process.env.INDEXER_URL!,
 * });
 *
 * const live = await indexer.listTournaments({ status: "Registration", limit: 20 });
 * const payouts = await indexer.getPayouts(tournamentPda.toBase58());
 * ```
 */
export class BracketChainIndexerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: IndexerClientOptions) {
    if (!opts.baseUrl) {
      throw new BracketChainSDKError(
        "BracketChainIndexerClient requires a baseUrl",
        "InvalidArgument",
      );
    }
    // Strip trailing slash so callers can pass either form without surprises.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");

    const f = opts.fetch ?? (typeof globalThis !== "undefined" ? globalThis.fetch : undefined);
    if (!f) {
      throw new BracketChainSDKError(
        "fetch is not available in this environment — pass a fetch implementation via options.fetch",
        "FetchUnavailable",
      );
    }
    // Bind to globalThis to avoid `Illegal invocation` errors when using
    // `globalThis.fetch` directly (some runtimes are picky).
    this.fetchImpl = f.bind(globalThis);
  }

  /**
   * GET /tournaments — list indexed tournaments, newest-first.
   *
   * Server-side pagination is not yet implemented; pass `limit` (default 20,
   * max 100) and filter client-side for organizer-specific views.
   */
  async listTournaments(opts: ListTournamentsOptions = {}): Promise<IndexerTournament[]> {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.limit) params.set("limit", String(opts.limit));

    const url = `${this.baseUrl}/tournaments${params.toString() ? `?${params}` : ""}`;
    return this.requestJson<IndexerTournament[]>(url, { signal: opts.signal });
  }

  /**
   * GET /tournaments/:address — single tournament aggregate.
   * Throws on 404 (tournament not indexed). Phase 5.3 SWR consumer catches
   * the typed error and falls back to chain reads.
   */
  async getTournament(
    address: string,
    opts: GetPayoutsOptions = {},
  ): Promise<IndexerTournament> {
    const url = `${this.baseUrl}/tournaments/${address}`;
    return this.requestJson<IndexerTournament>(url, { signal: opts.signal });
  }

  /**
   * GET /tournaments/:address/payouts — per-placement Prize rows + Fee + Refund rows.
   *
   * Returns `[]` when the tournament has not been completed and no refunds
   * have been issued. Throws on 404 (tournament not indexed) or 5xx —
   * callers in the SWR layer should catch and degrade to chain reads.
   */
  async getPayouts(address: string, opts: GetPayoutsOptions = {}): Promise<IndexerPayout[]> {
    const url = `${this.baseUrl}/tournaments/${address}/payouts`;
    return this.requestJson<IndexerPayout[]>(url, { signal: opts.signal });
  }

  /**
   * GET /tournaments/:address/participants — registered participants ordered
   * by seedIndex. Phase 5.2.
   */
  async getParticipants(
    address: string,
    opts: GetParticipantsOptions = {},
  ): Promise<IndexerParticipant[]> {
    const url = `${this.baseUrl}/tournaments/${address}/participants`;
    return this.requestJson<IndexerParticipant[]>(url, { signal: opts.signal });
  }

  /**
   * GET /tournaments/:address/matches — match rows ordered by (round, matchIndex).
   * Phase 5.2: populated from MatchReported events; pending/bye matches are
   * filled by Phase 5.4 reconciliation. Frontend should treat empty results
   * for an in-progress tournament as "fall back to chain".
   */
  async getMatches(address: string, opts: GetMatchesOptions = {}): Promise<IndexerMatch[]> {
    const url = `${this.baseUrl}/tournaments/${address}/matches`;
    return this.requestJson<IndexerMatch[]>(url, { signal: opts.signal });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async requestJson<T>(url: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      // Network failure / abort — wrap so callers get a typed error to filter on.
      if (err instanceof Error && err.name === "AbortError") {
        throw err;  // preserve abort semantics for AbortController users
      }
      throw new BracketChainSDKError(
        `Indexer request failed: ${err instanceof Error ? err.message : String(err)}`,
        "IndexerNetworkError",
        err,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new BracketChainSDKError(
        `Indexer ${res.status} ${res.statusText}: ${body || "(empty body)"}`,
        res.status >= 500 ? "IndexerServerError" : "IndexerClientError",
      );
    }
    return res.json() as Promise<T>;
  }
}

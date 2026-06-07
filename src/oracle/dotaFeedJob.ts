/**
 * Dota 2 winner-feed OracleJob builder — the single source of truth for the
 * job definition whose SHA-256 becomes `MatchCommitment.expected_feed_hash`.
 *
 * Layering note: this is a PROTOCOL determinism artifact (like `seeding.ts`),
 * not a platform client. The program validates `feed.feed_hash ==
 * expected_feed_hash` in `bind_match_feed`; this module is the canonical way
 * to produce those bytes. It does not talk to any server — `endpointBaseUrl`
 * is a caller-supplied parameter, and ANY operator hosting a compatible
 * `/oracle/dota-winner` endpoint produces a valid feed.
 *
 * ── Determinism contract (R-2) ───────────────────────────────────────────────
 * `feed_hash = SHA-256( queue_bytes ++ encodeDelimited(job) per job )` — see
 * `FeedHash.compute` in `@switchboard-xyz/common`. Every byte of the job
 * matters: the SAME builder with the SAME inputs MUST be used at all call
 * sites or `bind_match_feed` reverts with a hash mismatch:
 *
 *   1. frontend `CommitAndBindPanel` — computes `expected_feed_hash` at
 *      `commit_match_lobby` time;
 *   2. frontend `BindFeedModal` — creates the PullFeed with the same hash and
 *      stores the same jobs on Crossbar;
 *   3. indexer oracle module tests — assert the served route matches
 *      {@link buildDotaWinnerUrl} byte-for-byte.
 *
 * Inputs that must therefore be pinned across deployments:
 *   - `endpointBaseUrl` (`NEXT_PUBLIC_INDEXER_ORACLE_URL` /
 *     `ORACLE_ENDPOINT_BASE_URL`) — trailing slashes are stripped here so
 *     cosmetic variants agree;
 *   - the Switchboard queue (`ProtocolConfig.switchboard_queue`);
 *   - the `source` discriminator (`"opendota"` until the Steam source lands).
 *
 * The job itself is intentionally trivial — all winner-derivation logic
 * (shared-match lookup, radiant/dire mapping) lives behind the endpoint,
 * because the OracleJob task DSL cannot iterate arrays. Oracles just fetch
 * and parse:
 *
 *   HttpTask(GET {base}/oracle/dota-winner?lobby=…&a=…&b=…&source=opendota)
 *     → JsonParseTask($.winner)      // 0 = player_a won, 1 = player_b won
 *
 * The endpoint replies 404 while the match is unresolved, which makes the job
 * FAIL — no oracle submission lands on the feed (fail-closed), and
 * `propose_result_oracle` keeps rejecting on staleness/samples until a real
 * result exists.
 */

import { getBase58Encoder } from "@solana/kit";
import { FeedHash, OracleJob } from "@switchboard-xyz/common";
import type { IOracleJob } from "@switchboard-xyz/common";

// ─────────────────────────────────────────────────────────────────────────────
// Params
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Winner sources the endpoint understands. Phase 1.5 ships OpenDota only;
 * `"steam"` is reserved for the direct Steam Web API source (the mainnet
 * source-diversity path).
 */
export type DotaWinnerSource = "opendota";

export interface DotaFeedJobParams {
  /**
   * Public base URL of an oracle endpoint, WITHOUT the `/oracle/…` path
   * (e.g. `https://indexer.example.com`). Trailing slashes are stripped so
   * cosmetic variants produce identical hashes.
   */
  endpointBaseUrl: string;
  /** 16-byte match lobby id as 32 lowercase-hex chars (the on-chain
   * `MatchCommitment.lobby_id` / `commit_match_lobby` arg). */
  lobbyHex: string;
  /** Player A's 32-byte identity hash as 64 lowercase-hex chars
   * (= `Participant.identity_hash` = SHA-256(steam_id_64 LE)). */
  playerAGameIdHex: string;
  /** Player B's 32-byte identity hash, same encoding. */
  playerBGameIdHex: string;
  /** Winner source. Defaults to `"opendota"`. Part of the hashed URL. */
  source?: DotaWinnerSource;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation + URL
// ─────────────────────────────────────────────────────────────────────────────

const HEX_RE = /^[0-9a-f]+$/;

function requireHex(value: string, bytes: number, label: string): string {
  const normalized = value.toLowerCase();
  if (normalized.length !== bytes * 2 || !HEX_RE.test(normalized)) {
    throw new Error(
      `${label} must be ${bytes * 2} hex chars (${bytes} bytes), got "${value}"`,
    );
  }
  return normalized;
}

function normalizeBaseUrl(endpointBaseUrl: string): string {
  const trimmed = endpointBaseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error(
      `endpointBaseUrl must be an absolute http(s) URL, got "${endpointBaseUrl}"`,
    );
  }
  return trimmed;
}

/**
 * The exact URL embedded in the OracleJob — exported so the indexer's oracle
 * controller tests can assert route/query parity with what oracles fetch.
 * Query-param ORDER is part of the hash; never reorder.
 */
export function buildDotaWinnerUrl(p: DotaFeedJobParams): string {
  const base = normalizeBaseUrl(p.endpointBaseUrl);
  const lobby = requireHex(p.lobbyHex, 16, "lobbyHex");
  const a = requireHex(p.playerAGameIdHex, 32, "playerAGameIdHex");
  const b = requireHex(p.playerBGameIdHex, 32, "playerBGameIdHex");
  const source: DotaWinnerSource = p.source ?? "opendota";
  return `${base}/oracle/dota-winner?lobby=${lobby}&a=${a}&b=${b}&source=${source}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Job + feed hash
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the single-job feed definition. The returned `IOracleJob[]` is what
 * gets (a) hashed by {@link computeDotaFeedHash}, (b) stored on Crossbar so
 * oracles can resolve the hash back to tasks, and (c) referenced by the
 * PullFeed created in the bind flow.
 */
export function buildDotaWinnerJobs(p: DotaFeedJobParams): IOracleJob[] {
  return [
    OracleJob.fromObject({
      tasks: [
        { httpTask: { url: buildDotaWinnerUrl(p) } },
        // `$.winner` is an integer 0|1; Switchboard scales submissions by
        // 10^18 internally, so the on-chain reader sees 0 or 10^18 and the
        // program maps value == 0 → player_a, value == 10^18 → player_b.
        { jsonParseTask: { path: "$.winner" } },
      ],
    }),
  ];
}

/**
 * Compute the 32-byte `expected_feed_hash` for `commit_match_lobby` /
 * `bind_match_feed` — offline, no Crossbar round-trip. `queueBase58` MUST be
 * the protocol's configured Switchboard queue
 * (`ProtocolConfig.switchboard_queue`): the queue is part of the hash
 * preimage, so the same jobs on a different queue yield a different hash.
 */
export function computeDotaFeedHash(
  queueBase58: string,
  p: DotaFeedJobParams,
): Uint8Array {
  const queueBytes = new Uint8Array(getBase58Encoder().encode(queueBase58));
  // `FeedHash.compute` types its first arg as Buffer but only feeds it to
  // js-sha256's `update()`, which accepts any Uint8Array — cast instead of
  // dragging a Buffer polyfill into browser bundles.
  const hash = FeedHash.compute(
    queueBytes as unknown as Parameters<typeof FeedHash.compute>[0],
    buildDotaWinnerJobs(p),
  );
  return new Uint8Array(hash);
}

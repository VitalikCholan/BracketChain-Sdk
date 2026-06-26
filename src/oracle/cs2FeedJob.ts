/**
 * CS2 winner-feed OracleJob builder — the CS2 sibling of {@link ./dotaFeedJob}.
 * Same determinism contract: its SHA-256 becomes `MatchCommitment.expected_feed_hash`
 * and the program validates `feed.feed_hash == expected_feed_hash` in
 * `bind_match_feed`. Use the SAME builder + inputs at every call site or
 * `bind_match_feed` reverts on a hash mismatch.
 *
 * Difference from Dota 2: CS2 has no public match-history API. The winner comes
 * from a self-hosted DatHost server's `match_end` webhook, which the indexer
 * records and then serves at `/oracle/cs2-winner`. So `source` is `"dathost"`
 * and the job fetches that route:
 *
 *   HttpTask(GET {base}/oracle/cs2-winner?lobby=…&a=…&b=…&source=dathost)
 *     → JsonParseTask($.winner)      // 0 = player_a won, 1 = player_b won
 *
 * The endpoint replies 404 until the match is finished, so the job FAILS and no
 * oracle submission lands (fail-closed) until a real result exists — identical
 * to the Dota 2 flow. The `a`/`b` identity hashes are part of the hashed URL so
 * each match's feed is unique and bound to its two players (anti-redirection).
 */

import { getBase58Encoder } from "@solana/kit";
import { FeedHash, OracleJob } from "@switchboard-xyz/common";
import type { IOracleJob } from "@switchboard-xyz/common";

// ─────────────────────────────────────────────────────────────────────────────
// Params
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Winner sources the CS2 endpoint understands. Today only the self-hosted
 * DatHost server reports results.
 */
export type Cs2WinnerSource = "dathost";

export interface Cs2FeedJobParams {
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
  /** Winner source. Defaults to `"dathost"`. Part of the hashed URL. */
  source?: Cs2WinnerSource;
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
export function buildCs2WinnerUrl(p: Cs2FeedJobParams): string {
  const base = normalizeBaseUrl(p.endpointBaseUrl);
  const lobby = requireHex(p.lobbyHex, 16, "lobbyHex");
  const a = requireHex(p.playerAGameIdHex, 32, "playerAGameIdHex");
  const b = requireHex(p.playerBGameIdHex, 32, "playerBGameIdHex");
  const source: Cs2WinnerSource = p.source ?? "dathost";
  return `${base}/oracle/cs2-winner?lobby=${lobby}&a=${a}&b=${b}&source=${source}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Job + feed hash
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the single-job feed definition. The returned `IOracleJob[]` is what
 * gets (a) hashed by {@link computeCs2FeedHash}, (b) stored on Crossbar so
 * oracles can resolve the hash back to tasks, and (c) referenced by the
 * PullFeed created in the bind flow.
 */
export function buildCs2WinnerJobs(p: Cs2FeedJobParams): IOracleJob[] {
  return [
    OracleJob.fromObject({
      tasks: [
        { httpTask: { url: buildCs2WinnerUrl(p) } },
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
 * the protocol's configured Switchboard queue (`ProtocolConfig.switchboard_queue`):
 * the queue is part of the hash preimage, so the same jobs on a different queue
 * yield a different hash.
 */
export function computeCs2FeedHash(
  queueBase58: string,
  p: Cs2FeedJobParams,
): Uint8Array {
  const queueBytes = new Uint8Array(getBase58Encoder().encode(queueBase58));
  // `FeedHash.compute` types its first arg as Buffer but only feeds it to
  // js-sha256's `update()`, which accepts any Uint8Array — cast instead of
  // dragging a Buffer polyfill into browser bundles.
  const hash = FeedHash.compute(
    queueBytes as unknown as Parameters<typeof FeedHash.compute>[0],
    buildCs2WinnerJobs(p),
  );
  return new Uint8Array(hash);
}

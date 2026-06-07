/**
 * Determinism guard for the Dota 2 winner-feed job builder (R-2).
 *
 * The golden vector below pins `feed_hash = SHA-256(queue ++ jobs)` for fixed
 * inputs. If it ever changes — a bump of `@switchboard-xyz/common` altering
 * protobuf encoding, a query-param reorder, a task tweak — every feed bound
 * with the OLD hash becomes unbindable against commitments made with the NEW
 * one. Treat a diff here exactly like a seeding.rs golden-vector diff: stop,
 * understand which side drifted, and never "just update the constant" while
 * any live tournament has open Oracle commitments.
 *
 * Runs under the package test runner: `pnpm test` (node --import tsx --test).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FeedHash } from "@switchboard-xyz/common";

import {
  buildDotaWinnerJobs,
  buildDotaWinnerUrl,
  computeDotaFeedHash,
  type DotaFeedJobParams,
} from "./dotaFeedJob";

// Canonical Switchboard On-Demand devnet queue (same default as
// scripts/set-oracle-config.ts).
const QUEUE = "EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7";

const PARAMS: DotaFeedJobParams = {
  endpointBaseUrl: "https://oracle.example.com",
  lobbyHex: "00112233445566778899aabbccddeeff",
  playerAGameIdHex: "aa".repeat(32),
  playerBGameIdHex: "bb".repeat(32),
};

// Computed once against @switchboard-xyz/common 5.8 (protobuf encodeDelimited
// + js-sha256). Shared contract with the on-chain `bind_match_feed` check.
const GOLDEN_FEED_HASH_HEX =
  "9f1980a08ea66ae96d0f3a222ae3328388e64cafe701c309585022e59e0b3fc3";

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("buildDotaWinnerUrl", () => {
  it("produces the canonical URL with pinned query-param order", () => {
    assert.equal(
      buildDotaWinnerUrl(PARAMS),
      `https://oracle.example.com/oracle/dota-winner?lobby=${PARAMS.lobbyHex}&a=${"aa".repeat(32)}&b=${"bb".repeat(32)}&source=opendota`,
    );
  });

  it("normalizes trailing slashes and uppercase hex", () => {
    const variant = buildDotaWinnerUrl({
      ...PARAMS,
      endpointBaseUrl: "https://oracle.example.com///",
      lobbyHex: PARAMS.lobbyHex.toUpperCase(),
    });
    assert.equal(variant, buildDotaWinnerUrl(PARAMS));
  });

  it("rejects malformed inputs", () => {
    assert.throws(() => buildDotaWinnerUrl({ ...PARAMS, lobbyHex: "abcd" }));
    assert.throws(() =>
      buildDotaWinnerUrl({ ...PARAMS, playerAGameIdHex: "zz".repeat(32) }),
    );
    assert.throws(() =>
      buildDotaWinnerUrl({ ...PARAMS, endpointBaseUrl: "oracle.example.com" }),
    );
  });
});

describe("computeDotaFeedHash", () => {
  it("matches the golden vector", () => {
    assert.equal(toHex(computeDotaFeedHash(QUEUE, PARAMS)), GOLDEN_FEED_HASH_HEX);
  });

  it("is deterministic across calls", () => {
    assert.equal(
      toHex(computeDotaFeedHash(QUEUE, PARAMS)),
      toHex(computeDotaFeedHash(QUEUE, PARAMS)),
    );
  });

  it("is insensitive to cosmetic input variants (slash / case)", () => {
    const cosmetic = computeDotaFeedHash(QUEUE, {
      ...PARAMS,
      endpointBaseUrl: "https://oracle.example.com/",
      playerBGameIdHex: PARAMS.playerBGameIdHex.toUpperCase(),
    });
    assert.equal(toHex(cosmetic), GOLDEN_FEED_HASH_HEX);
  });

  it("flips on a one-character URL drift", () => {
    const drifted = computeDotaFeedHash(QUEUE, {
      ...PARAMS,
      endpointBaseUrl: "https://oracle.example.con",
    });
    assert.notEqual(toHex(drifted), GOLDEN_FEED_HASH_HEX);
  });

  it("flips on a different queue (queue is part of the preimage)", () => {
    const otherQueue = computeDotaFeedHash(
      "A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w",
      PARAMS,
    );
    assert.notEqual(toHex(otherQueue), GOLDEN_FEED_HASH_HEX);
  });

  it("cross-checks against a direct FeedHash.compute call", () => {
    const queueBytes = Buffer.from(
      computeQueueBytesForTest(QUEUE),
    );
    const direct = FeedHash.compute(queueBytes, buildDotaWinnerJobs(PARAMS));
    assert.equal(direct.toString("hex"), GOLDEN_FEED_HASH_HEX);
  });
});

// Minimal base58 decode for the cross-check (Bitcoin alphabet) — keeps the
// test independent from the kit encoder the implementation uses.
function computeQueueBytesForTest(s: string): Uint8Array {
  const ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    assert.ok(i >= 0, "invalid base58 input");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c === "1") bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}

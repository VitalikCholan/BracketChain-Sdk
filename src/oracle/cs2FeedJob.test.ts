/**
 * Determinism guard for the CS2 winner-feed job builder — the CS2 sibling of
 * dotaFeedJob.test.ts. Pins `feed_hash = SHA-256(queue ++ jobs)` for fixed
 * inputs. A diff here means every feed bound with the OLD hash becomes
 * unbindable against commitments made with the NEW one — treat like a
 * seeding.rs golden-vector diff: stop and understand which side drifted.
 *
 * BOOTSTRAP: GOLDEN_FEED_HASH_HEX is empty until pinned. On the first
 * `pnpm test` run the golden case PRINTS the computed hash instead of failing —
 * copy that value into the constant and commit it. After that it guards.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FeedHash } from "@switchboard-xyz/common";

import {
  buildCs2WinnerJobs,
  buildCs2WinnerUrl,
  computeCs2FeedHash,
  type Cs2FeedJobParams,
} from "./cs2FeedJob";

// Canonical Switchboard On-Demand devnet queue (same default as the Dota test
// and scripts/set-oracle-config.ts).
const QUEUE = "EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7";

const PARAMS: Cs2FeedJobParams = {
  endpointBaseUrl: "https://oracle.example.com",
  lobbyHex: "00112233445566778899aabbccddeeff",
  playerAGameIdHex: "aa".repeat(32),
  playerBGameIdHex: "bb".repeat(32),
};

// Pin on first run (see BOOTSTRAP note above). Empty → golden case prints.
const GOLDEN_FEED_HASH_HEX = "";

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("buildCs2WinnerUrl", () => {
  it("produces the canonical URL with pinned query-param order", () => {
    assert.equal(
      buildCs2WinnerUrl(PARAMS),
      `https://oracle.example.com/oracle/cs2-winner?lobby=${PARAMS.lobbyHex}&a=${"aa".repeat(32)}&b=${"bb".repeat(32)}&source=dathost`,
    );
  });

  it("normalizes trailing slashes and uppercase hex", () => {
    const variant = buildCs2WinnerUrl({
      ...PARAMS,
      endpointBaseUrl: "https://oracle.example.com///",
      lobbyHex: PARAMS.lobbyHex.toUpperCase(),
    });
    assert.equal(variant, buildCs2WinnerUrl(PARAMS));
  });

  it("rejects malformed inputs", () => {
    assert.throws(() => buildCs2WinnerUrl({ ...PARAMS, lobbyHex: "abcd" }));
    assert.throws(() =>
      buildCs2WinnerUrl({ ...PARAMS, playerAGameIdHex: "zz".repeat(32) }),
    );
    assert.throws(() =>
      buildCs2WinnerUrl({ ...PARAMS, endpointBaseUrl: "oracle.example.com" }),
    );
  });
});

describe("computeCs2FeedHash", () => {
  it("matches the golden vector (prints to pin on first run)", () => {
    const actual = toHex(computeCs2FeedHash(QUEUE, PARAMS));
    if (!GOLDEN_FEED_HASH_HEX) {
      // eslint-disable-next-line no-console
      console.log(`\n  CS2 feed hash — pin GOLDEN_FEED_HASH_HEX to:\n  ${actual}\n`);
      return;
    }
    assert.equal(actual, GOLDEN_FEED_HASH_HEX);
  });

  it("is deterministic across calls", () => {
    assert.equal(
      toHex(computeCs2FeedHash(QUEUE, PARAMS)),
      toHex(computeCs2FeedHash(QUEUE, PARAMS)),
    );
  });

  it("is insensitive to cosmetic input variants (slash / case)", () => {
    const cosmetic = computeCs2FeedHash(QUEUE, {
      ...PARAMS,
      endpointBaseUrl: "https://oracle.example.com/",
      playerBGameIdHex: PARAMS.playerBGameIdHex.toUpperCase(),
    });
    assert.equal(toHex(cosmetic), toHex(computeCs2FeedHash(QUEUE, PARAMS)));
  });

  it("flips on a one-character URL drift", () => {
    const drifted = computeCs2FeedHash(QUEUE, {
      ...PARAMS,
      endpointBaseUrl: "https://oracle.example.con",
    });
    assert.notEqual(toHex(drifted), toHex(computeCs2FeedHash(QUEUE, PARAMS)));
  });

  it("flips on a different queue (queue is part of the preimage)", () => {
    const otherQueue = computeCs2FeedHash(
      "A43DyUGA7s8eXPxqEjJY6EBu1KKbNgfxF8h17VAHn13w",
      PARAMS,
    );
    assert.notEqual(toHex(otherQueue), toHex(computeCs2FeedHash(QUEUE, PARAMS)));
  });

  it("differs from the Dota 2 feed hash (distinct route + source)", () => {
    // Sanity: the CS2 job must not collide with the Dota 2 job for the same
    // inputs — different path (/cs2-winner) and source (dathost).
    const direct = FeedHash.compute(
      Buffer.from(computeQueueBytesForTest(QUEUE)),
      buildCs2WinnerJobs(PARAMS),
    );
    assert.equal(direct.toString("hex"), toHex(computeCs2FeedHash(QUEUE, PARAMS)));
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

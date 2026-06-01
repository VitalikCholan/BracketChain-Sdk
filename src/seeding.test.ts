/**
 * Cross-language determinism guard for the bracket seeding (H-2).
 *
 * No test framework is wired in this package yet, so run directly:
 *   pnpm tsx src/seeding.test.ts
 *
 * The golden vector below is shared verbatim with the on-chain
 * `seeding.rs::cross_language_golden_vector` test. If either side's splitmix64 /
 * Fisher-Yates changes, this assertion (and the Rust one) must be updated
 * together — a mismatch means `start_tournament` would reject SDK-built brackets.
 */
import assert from "node:assert/strict";

import { round0Expected, seedPermutation } from "./seeding";

// Seed = bytes 0..31; n = 8.
const seed = new Uint8Array(32);
for (let i = 0; i < 32; i++) seed[i] = i;

const perm = seedPermutation(seed, 8);
assert.deepEqual(perm, [4, 0, 3, 1, 5, 6, 7, 2], "splitmix64 Fisher-Yates must match seeding.rs");

// Determinism: same seed → same permutation.
assert.deepEqual(seedPermutation(seed, 8), perm);

// Bijection over 0..n for a range of sizes.
for (const n of [2, 3, 5, 7, 8, 17, 64, 100, 128]) {
  const p = seedPermutation(seed, n);
  assert.equal(new Set(p).size, n, `permutation of 0..${n} must be a bijection`);
  assert.ok(p.every((x) => x >= 0 && x < n));
}

// Standard-seeding byes: n=5 → bracket 8 → 3 byes, player_a always real.
{
  const n = 5;
  const bracket = 8;
  const p = seedPermutation(seed, n);
  let byes = 0;
  for (let m = 0; m < bracket / 2; m++) {
    const [a, b] = round0Expected(p, m, bracket, n);
    assert.ok(a < n, "player_a (rank m) is always real");
    if (b === null) byes++;
  }
  assert.equal(byes, bracket - n, "exactly bracket - n byes");
}

console.log("seeding.test.ts: OK — cross-language golden vector matches seeding.rs");

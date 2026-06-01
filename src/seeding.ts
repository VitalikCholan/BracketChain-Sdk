/**
 * Canonical, cross-language-deterministic bracket seeding (H-2).
 *
 * Byte-identical mirror of the on-chain `seeding.rs`: the program re-derives the
 * exact same permutation from `tournament.seed_hash` and rejects any bracket
 * that does not match it. Every primitive here uses masked `BigInt` `u64`
 * arithmetic so it reproduces Rust's wrapping `splitmix64` exactly. Keep the two
 * files in lockstep — the `cross_language_golden_vector` test pins them.
 *
 * Single-elimination only (V1).
 */

const MASK = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;
const M1 = 0xbf58476d1ce4e5b9n;
const M2 = 0x94d049bb133111ebn;

/** splitmix64 finalizer (shared by the seed absorption and the output stream). */
function mix(x: bigint): bigint {
  let z = ((x ^ (x >> 30n)) * M1) & MASK;
  z = ((z ^ (z >> 27n)) * M2) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}

/**
 * Folds the 32-byte VRF seed into a 64-bit state, absorbing each little-endian
 * 8-byte word and running the finalizer after every word (so symmetric inputs
 * do not cancel). Mirror of `seed_state` in `seeding.rs`.
 */
function seedState(seedHash: Uint8Array): bigint {
  let s = GOLDEN;
  for (let k = 0; k < 32; k += 8) {
    let w = 0n;
    for (let b = 0; b < 8; b++) {
      w |= BigInt(seedHash[k + b]) << BigInt(8 * b);
    }
    s = mix((s ^ w) & MASK);
  }
  return s;
}

/** Advance `state`, return the next 64-bit value. Mirror of `next_u64`. */
function nextU64(state: bigint): { value: bigint; state: bigint } {
  const ns = (state + GOLDEN) & MASK;
  return { value: mix(ns), state: ns };
}

/**
 * Fisher-Yates permutation of `[0, n)` seeded by `seedHash`. `perm[rank]` is the
 * `seedIndex` (join order) of the participant placed at bracket seed-rank
 * `rank`. Mirror of `seed_permutation`; `n ≤ 128`.
 */
export function seedPermutation(seedHash: Uint8Array, n: number): number[] {
  const perm = Array.from({ length: n }, (_, i) => i);
  let state = seedState(seedHash);
  for (let i = n - 1; i >= 1; i--) {
    const r = nextU64(state);
    state = r.state;
    const j = Number(r.value % BigInt(i + 1));
    const tmp = perm[i];
    perm[i] = perm[j];
    perm[j] = tmp;
  }
  return perm;
}

/**
 * Standard single-elim round-0 assignment for match `m`: seed-rank `m` vs
 * `bracketSize - 1 - m`. Returns the participants' `seedIndex` values
 * `[playerASeedIndex, playerBSeedIndex | null]` where `null` == bye. Mirror of
 * `round0_expected`. `playerA` (rank `m`) is always real; byes fall against the
 * top seeds, one per match.
 */
export function round0Expected(
  perm: number[],
  m: number,
  bracketSize: number,
  n: number,
): [number, number | null] {
  const aRank = m;
  const bRank = bracketSize - 1 - m;
  const a = perm[aRank];
  const b = bRank < n ? perm[bRank] : null;
  return [a, b];
}

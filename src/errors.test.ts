/**
 * Unit coverage for the on-chain error → SDK error mapping (bugs #2 + #3).
 *
 * No bundler/devnet needed — we synthesize Kit `SolanaError`s with the same
 * shape `mapError` walks for. Run:
 *   pnpm tsx src/errors.test.ts          # direct
 *   node --import tsx --test             # whole suite
 *
 * The drift-guard (`maps every code in [6000, 6059]`) is the behavioral
 * backstop against the program growing new `#[error_code]`s without a matching
 * row in `ERRORS_RS_ORDER` — exactly the regression that produced bug #2.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SolanaError,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_ALREADY_INITIALIZED,
} from "@solana/kit";

import {
  AttestationRequiredError,
  BracketChainSDKError,
  ClaimWindowNotElapsedError,
  FormatNotYetSupportedError,
  GameNotSupportedError,
  InsufficientBalanceError,
  InsufficientFundsError,
  InvalidAttestationError,
  InvalidPayoutPresetError,
  NonParticipantWinnerError,
  SeedNotRevealedError,
  SettlementModeError,
  TransactionFailedError,
  UnauthorizedReporterError,
  UnknownProgramError,
  isAccountAlreadyInitialized,
  mapError,
} from "./errors";

// ── fixtures ────────────────────────────────────────────────────────────────

/** A bare Anchor `InstructionError::Custom` carrying the on-chain error code. */
const custom = (code: number): SolanaError =>
  new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, {
    code,
    index: 0,
  } as never);

/** Wrap an error as the `.cause` of an opaque outer error (preflight-style). */
const nested = (inner: unknown): Error => {
  const outer = new Error("send transaction preflight failure");
  (outer as { cause?: unknown }).cause = inner;
  return outer;
};

// ── A. typed-class mapping (sample across every tier) ─────────────────────────

describe("mapError — typed class mapping", () => {
  const cases: Array<[number, new (cause?: unknown) => BracketChainSDKError]> = [
    [6000, UnauthorizedReporterError],
    [6024, GameNotSupportedError],
    [6025, AttestationRequiredError],
    [6032, SettlementModeError],
    [6038, ClaimWindowNotElapsedError],
    [6041, SeedNotRevealedError],
    [6065, FormatNotYetSupportedError],
    // Tier B — reuse of existing classes
    [6055, InvalidPayoutPresetError], // InvalidCustomPayout
    [6037, NonParticipantWinnerError], // InvalidProposedWinner
    [6058, NonParticipantWinnerError], // NonParticipantInBracket
  ];
  for (const [code, Ctor] of cases) {
    it(`code ${code} → ${Ctor.name}`, () => {
      const fixture = custom(code);
      const err = mapError(fixture);
      assert.ok(err instanceof Ctor, `expected ${Ctor.name}, got ${err.constructor.name}`);
      assert.equal(err.cause, fixture, "original SolanaError preserved in cause");
    });
  }

  it("all six SAS attestation codes (6026-6031) collapse to InvalidAttestationError", () => {
    for (let code = 6026; code <= 6031; code++) {
      assert.ok(
        mapError(custom(code)) instanceof InvalidAttestationError,
        `code ${code} should be InvalidAttestationError`,
      );
    }
  });
});

// ── B. regression for bug #3 — generic codes keep a real message + cause ──────

describe("mapError — generic TransactionFailedError codes (bug #3 regression)", () => {
  // The 7 codes previously mapped with `TransactionFailedError as never`, which
  // passed the error object into the `message` param and dropped `cause`.
  const genericCodes = [6006, 6012, 6017, 6018, 6021, 6022, 6023];
  for (const code of genericCodes) {
    it(`code ${code} → descriptive TransactionFailedError, cause preserved`, () => {
      const fixture = custom(code);
      const err = mapError(fixture);
      assert.ok(err instanceof TransactionFailedError);
      assert.equal(err.code, "TransactionFailed");
      assert.equal(err.cause, fixture, "cause must be the original error");
      assert.notEqual(err.message, "[object Object]");
      assert.ok(err.message.length > 0 && !/object Object/.test(err.message));
    });
  }

  it("6017 (InvalidVault) carries the program's vault message", () => {
    const err = mapError(custom(6017));
    assert.match(err.message, /vault/i);
  });
});

// ── C. drift-guard for bug #2 — every code in range is named ──────────────────

describe("mapError — error-code coverage (bug #2 drift-guard)", () => {
  it("maps every code in [6000, 6065] without falling through to generic", () => {
    const unmapped: number[] = [];
    for (let code = 6000; code <= 6065; code++) {
      if (/On-chain custom error code/.test(mapError(custom(code)).message)) {
        unmapped.push(code);
      }
    }
    assert.deepEqual(
      unmapped,
      [],
      `these codes lack a row in ERRORS_RS_ORDER (program grew? add them): ${unmapped.join(", ")}`,
    );
  });

  it("an out-of-range code (6066) falls through to the generic fallback", () => {
    const err = mapError(custom(6066));
    assert.ok(err instanceof TransactionFailedError);
    assert.match(err.message, /On-chain custom error code 6066/);
  });
});

// ── D. cause-chain walking ────────────────────────────────────────────────────

describe("mapError — cause-chain handling", () => {
  it("reaches a Custom code nested inside a wrapper's cause", () => {
    assert.ok(mapError(nested(custom(6032))) instanceof SettlementModeError);
  });

  it("terminates on a self-referential cause cycle", () => {
    const cyclic = new Error("loop") as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    assert.ok(mapError(cyclic) instanceof UnknownProgramError);
  });
});

// ── E. non-program fallbacks ──────────────────────────────────────────────────

describe("mapError — message heuristics + fallbacks", () => {
  it("'insufficient lamports' → InsufficientFundsError", () => {
    assert.ok(
      mapError(new Error("insufficient lamports for rent")) instanceof InsufficientFundsError,
    );
  });

  it("'insufficient funds' → InsufficientBalanceError", () => {
    assert.ok(mapError(new Error("insufficient funds")) instanceof InsufficientBalanceError);
  });

  it("unrecognised Error → UnknownProgramError, cause preserved", () => {
    const e = new Error("something else");
    const mapped = mapError(e);
    assert.ok(mapped instanceof UnknownProgramError);
    assert.equal(mapped.cause, e);
  });

  it("non-Error input does not throw", () => {
    assert.ok(mapError("a string" as unknown) instanceof UnknownProgramError);
    assert.ok(mapError(undefined) instanceof UnknownProgramError);
  });
});

// ── F. idempotency ────────────────────────────────────────────────────────────

describe("mapError — idempotency", () => {
  it("returns an existing BracketChainSDKError unchanged (same reference)", () => {
    const original = mapError(custom(6000));
    assert.equal(mapError(original), original);
  });
});

// ── G. isAccountAlreadyInitialized ────────────────────────────────────────────

describe("isAccountAlreadyInitialized", () => {
  it("true when the chain contains AccountAlreadyInitialized", () => {
    const e = new SolanaError(
      SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_ALREADY_INITIALIZED,
      {} as never,
    );
    assert.equal(isAccountAlreadyInitialized(nested(e)), true);
  });

  it("false for an unrelated error", () => {
    assert.equal(isAccountAlreadyInitialized(custom(6000)), false);
  });
});

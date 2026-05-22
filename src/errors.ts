import {
  isSolanaError,
  SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_ALREADY_INITIALIZED,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__INSTRUCTION_ERROR__INSUFFICIENT_FUNDS,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
} from "@solana/kit";

// ─────────────────────────────────────────────────────────────────────────────
// Base class — all SDK errors extend this. Consumers can `instanceof`-check
// specific subclasses or fall back to BracketChainSDKError.
// ─────────────────────────────────────────────────────────────────────────────

export class BracketChainSDKError extends Error {
  /** Original error if available — useful for debugging unmapped cases. */
  public readonly cause?: unknown;
  /** Stable error code that won't change across SDK versions (matches the class name). */
  public readonly code: string;

  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.name = code;
    this.code = code;
    this.cause = cause;
    const errCtor = Error as unknown as {
      captureStackTrace?: (target: object, ctor: Function) => void;
    };
    if (typeof errCtor.captureStackTrace === "function") {
      errCtor.captureStackTrace(this, new.target);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// US-D01: createTournament errors
// ─────────────────────────────────────────────────────────────────────────────

export class InsufficientFundsError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "Wallet has insufficient SOL to pay for rent or transaction fees.",
      "InsufficientFunds",
      cause,
    );
  }
}

export class InvalidPayoutPresetError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "Selected payout preset is invalid or requires more participants than configured (e.g. Deep needs ≥7 players).",
      "InvalidPayoutPreset",
      cause,
    );
  }
}

export class RegistrationClosedError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "Tournament registration is closed (deadline passed or status is no longer Registration).",
      "RegistrationClosed",
      cause,
    );
  }
}

export class NameTooLongError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super("Tournament name exceeds 32 bytes.", "NameTooLong", cause);
  }
}

export class MaxParticipantsExceededError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "maxParticipants exceeds the on-chain cap of 128.",
      "MaxParticipantsExceeded",
      cause,
    );
  }
}

export class MinParticipantsNotMetError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "maxParticipants is below the on-chain minimum of 2.",
      "MinParticipantsNotMet",
      cause,
    );
  }
}

export class InvalidTokenMintError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "Token mint provided to the instruction does not match the tournament's configured mint, or is not a valid SPL Mint.",
      "InvalidTokenMint",
      cause,
    );
  }
}

export class ProtocolNotInitializedError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "ProtocolConfig PDA is not initialized — call initializeProtocol first.",
      "ProtocolNotInitialized",
      cause,
    );
  }
}

export class TournamentNameTakenError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "You already have a tournament with this name. Tournament PDA seeds are [organizer, name] — pick a different name.",
      "TournamentNameTaken",
      cause,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// US-D02: joinTournament errors
// ─────────────────────────────────────────────────────────────────────────────

export class TournamentFullError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "Tournament has reached its maximum participant count.",
      "TournamentFull",
      cause,
    );
  }
}

export class AlreadyRegisteredError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "This wallet is already registered for the tournament.",
      "AlreadyRegistered",
      cause,
    );
  }
}

export class InsufficientBalanceError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "Wallet's token balance is below the entry fee.",
      "InsufficientBalance",
      cause,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// US-D03: reportResult errors
// ─────────────────────────────────────────────────────────────────────────────

export class UnauthorizedReporterError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "Only the tournament organizer can report match results or cancel.",
      "UnauthorizedReporter",
      cause,
    );
  }
}

export class InvalidMatchError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "Match index is out of bounds, parents are not yet completed, or match doesn't belong to this tournament.",
      "InvalidMatch",
      cause,
    );
  }
}

export class MatchAlreadyReportedError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "This match has already been reported and cannot be reported again.",
      "MatchAlreadyReported",
      cause,
    );
  }
}

export class TournamentNotActiveError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "Tournament is not in the Active state — cannot report match results.",
      "TournamentNotActive",
      cause,
    );
  }
}

export class NonParticipantWinnerError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "Reported winner is not one of the two players in this match.",
      "NonParticipantWinner",
      cause,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// cancelTournament errors
// ─────────────────────────────────────────────────────────────────────────────

export class TournamentInProgressError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "Tournament has matches in progress and cannot be cancelled. V1 will support partial cancellation.",
      "TournamentInProgress",
      cause,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic / fallback
// ─────────────────────────────────────────────────────────────────────────────

export class TransactionFailedError extends BracketChainSDKError {
  constructor(message: string, cause?: unknown) {
    super(message, "TransactionFailed", cause);
  }
}

export class UnknownProgramError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "An unknown program error occurred. Inspect `cause` for details.",
      "UnknownProgramError",
      cause,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// On-chain BracketChainError code → SDK class lookup.
//
// Anchor numbers `#[error_code]` enums sequentially from 6000. The order in
// `bracket-chain-programs/src/errors.rs` determines the code.
//
// If you add a new error code on-chain, add a row here. Order MATTERS.
// ─────────────────────────────────────────────────────────────────────────────

const ANCHOR_ERROR_OFFSET = 6000;

const ERRORS_RS_ORDER = [
  "UnauthorizedAuthority", // 6000
  "TournamentFull", // 6001
  "AlreadyRegistered", // 6002
  "RegistrationClosed", // 6003
  "NotInRegistration", // 6004
  "NotActive", // 6005
  "NotCompleted", // 6006
  "InvalidPayoutPreset", // 6007
  "PresetExceedsParticipants", // 6008
  "MatchAlreadyReported", // 6009
  "NonParticipantWinner", // 6010
  "TournamentInProgress", // 6011
  "RefundAlreadyIssued", // 6012
  "MaxParticipantsExceeded", // 6013
  "MinParticipantsNotMet", // 6014
  "NameTooLong", // 6015
  "InvalidTokenMint", // 6016
  "InvalidVault", // 6017
  "InvalidTreasury", // 6018
  "InvalidMatchIndex", // 6019
  "ParentMatchesNotComplete", // 6020
  "RemainingAccountsMismatch", // 6021
  "ArithmeticOverflow", // 6022
  "SlotHashesUnavailable", // 6023
] as const;

type OnChainErrorName = (typeof ERRORS_RS_ORDER)[number];

const ON_CHAIN_TO_SDK: Record<
  OnChainErrorName,
  new (cause?: unknown) => BracketChainSDKError
> = {
  UnauthorizedAuthority: UnauthorizedReporterError,
  TournamentFull: TournamentFullError,
  AlreadyRegistered: AlreadyRegisteredError,
  RegistrationClosed: RegistrationClosedError,
  NotInRegistration: RegistrationClosedError,
  NotActive: TournamentNotActiveError,
  NotCompleted: TransactionFailedError as never,
  InvalidPayoutPreset: InvalidPayoutPresetError,
  PresetExceedsParticipants: InvalidPayoutPresetError,
  MatchAlreadyReported: MatchAlreadyReportedError,
  NonParticipantWinner: NonParticipantWinnerError,
  TournamentInProgress: TournamentInProgressError,
  RefundAlreadyIssued: TransactionFailedError as never,
  MaxParticipantsExceeded: MaxParticipantsExceededError,
  MinParticipantsNotMet: MinParticipantsNotMetError,
  NameTooLong: NameTooLongError,
  InvalidTokenMint: InvalidTokenMintError,
  InvalidVault: TransactionFailedError as never,
  InvalidTreasury: TransactionFailedError as never,
  InvalidMatchIndex: InvalidMatchError,
  ParentMatchesNotComplete: InvalidMatchError,
  RemainingAccountsMismatch: TransactionFailedError as never,
  ArithmeticOverflow: TransactionFailedError as never,
  SlotHashesUnavailable: TransactionFailedError as never,
};

// ─────────────────────────────────────────────────────────────────────────────
// Cause-chain walker for SolanaError → SDK typed errors.
// ─────────────────────────────────────────────────────────────────────────────

interface CauseLike {
  cause?: unknown;
}

/**
 * Iterate over `err` and every nested `.cause` until exhausted or a cycle is
 * detected. Used to reach the on-chain `InstructionError::Custom` buried inside
 * a JSON-RPC preflight error.
 */
function* walkCauses(err: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = (current as CauseLike)?.cause;
  }
}

/**
 * Convert any low-level error (Kit `SolanaError`, RPC failure, fetch error)
 * into a typed `BracketChainSDKError` subclass.
 *
 * If the error is already a `BracketChainSDKError`, returns it unchanged.
 * For unrecognised errors, returns `UnknownProgramError` wrapping the original.
 */
export function mapError(err: unknown): BracketChainSDKError {
  if (err instanceof BracketChainSDKError) return err;

  // Walk the cause chain (top-level → ... → nested SolanaError) looking for
  // an instruction-level Custom code, which carries the Anchor error number.
  for (const node of walkCauses(err)) {
    if (isSolanaError(node, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
      const codeNumber = node.context.code;
      if (
        typeof codeNumber === "number" &&
        codeNumber >= ANCHOR_ERROR_OFFSET
      ) {
        const idx = codeNumber - ANCHOR_ERROR_OFFSET;
        const name = ERRORS_RS_ORDER[idx];
        if (name) {
          const Ctor = ON_CHAIN_TO_SDK[name];
          if (Ctor) return new Ctor(err);
        }
      }
      return new TransactionFailedError(
        `On-chain custom error code ${codeNumber}`,
        err,
      );
    }

    if (
      isSolanaError(node, SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_ALREADY_INITIALIZED)
    ) {
      // Anchor `init` on an existing PDA. Different methods need different
      // surface errors (create → TournamentNameTaken, join → AlreadyRegistered),
      // so call sites disambiguate before falling through to mapError.
      return new TransactionFailedError("Account already initialized", err);
    }

    if (isSolanaError(node, SOLANA_ERROR__INSTRUCTION_ERROR__INSUFFICIENT_FUNDS)) {
      return new InsufficientFundsError(err);
    }

    if (isSolanaError(node, SOLANA_ERROR__ACCOUNTS__ACCOUNT_NOT_FOUND)) {
      return new UnknownProgramError(err);
    }

    if (
      isSolanaError(
        node,
        SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
      )
    ) {
      // Continue walking — the actual cause is nested inside this wrapper.
      continue;
    }
  }

  const message = err instanceof Error ? err.message : String(err);
  if (/insufficient (?:funds|lamports)/i.test(message)) {
    if (/lamports/i.test(message)) return new InsufficientFundsError(err);
    return new InsufficientBalanceError(err);
  }

  return new UnknownProgramError(err);
}

/**
 * True if any node in the cause chain is a `SolanaError` with code
 * `SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_ALREADY_INITIALIZED`. Used by
 * call sites to disambiguate the surface error before delegating to `mapError`.
 */
export function isAccountAlreadyInitialized(err: unknown): boolean {
  for (const node of walkCauses(err)) {
    if (
      isSolanaError(
        node,
        SOLANA_ERROR__INSTRUCTION_ERROR__ACCOUNT_ALREADY_INITIALIZED,
      )
    ) {
      return true;
    }
  }
  return false;
}

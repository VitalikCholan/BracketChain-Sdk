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
// V1.1 — game identity (SAS) + settlement-mode errors
// ─────────────────────────────────────────────────────────────────────────────

export class GameNotSupportedError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "Selected game is not yet supported for tournament creation (Phase 1: Manual + Dota2 only).",
      "GameNotSupported",
      cause,
    );
  }
}

export class AttestationRequiredError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "This game requires a SAS identity attestation to join — pass `gameIdentityAttestation`.",
      "AttestationRequired",
      cause,
    );
  }
}

/**
 * Covers every SAS attestation validation failure on join (wrong owner /
 * credential / schema, wallet-nonce mismatch, expired, malformed). The exact
 * on-chain code is preserved in `cause`.
 */
export class InvalidAttestationError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "SAS identity attestation is invalid for this tournament (owner, credential, schema, wallet binding, expiry, or data).",
      "InvalidAttestation",
      cause,
    );
  }
}

export class SettlementModeError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "This action is not allowed for the tournament's settlement mode.",
      "SettlementModeMismatch",
      cause,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// V1 player-reported / VRF settlement errors
// ─────────────────────────────────────────────────────────────────────────────

export class ClaimWindowNotElapsedError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "The dispute/claim window has not elapsed yet — a permissionless claim is not allowed.",
      "ClaimWindowNotElapsed",
      cause,
    );
  }
}

export class SeedNotRevealedError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "Tournament seed has not been revealed yet — start is gated on VRF (call requestSeed / revealSeed first).",
      "SeedNotRevealed",
      cause,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// R15 formats schema-prep
// ─────────────────────────────────────────────────────────────────────────────

export class FormatNotYetSupportedError extends BracketChainSDKError {
  constructor(cause?: unknown) {
    super(
      "Tournament format is reserved but not yet supported — V1 is single-elimination only (DoubleElim / Swiss / RoundRobin ship in formats Phases A-C).",
      "FormatNotYetSupported",
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
// If you add a new error code on-chain, add a row here. Order MATTERS — it is
// the Anchor ordinal contract (code = 6000 + index). Append only; never reorder.
// Mirrors `bracket-chain-programs/src/errors.rs` (and `target/idl` errors[]).
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
  // ── V1.1 game identity (SAS) ──────────────────────────────────────────────
  "GameNotYetSupported", // 6024
  "AttestationRequired", // 6025
  "InvalidAttestationOwner", // 6026
  "WrongAttestationCredential", // 6027
  "WrongAttestationSchema", // 6028
  "AttestationWalletMismatch", // 6029
  "AttestationExpired", // 6030
  "MalformedAttestation", // 6031
  // ── Player-reported / Oracle settlement (Stage B) ─────────────────────────
  "SettlementModeMismatch", // 6032
  "NotPlayerInMatch", // 6033
  "NotCounterparty", // 6034
  "NoProposal", // 6035
  "ProposalAlreadyExists", // 6036
  "InvalidProposedWinner", // 6037
  "ClaimWindowNotElapsed", // 6038
  "ProposalDisputed", // 6039
  "ProposalNotDisputed", // 6040
  // ── VRF seeding (Stage B) ─────────────────────────────────────────────────
  "SeedNotRevealed", // 6041
  "RandomnessNotResolved", // 6042
  "RandomnessAccountMismatch", // 6043
  "InvalidRandomnessOwner", // 6044
  "MalformedRandomness", // 6045
  "SeedAlreadyRevealed", // 6046
  "InvalidTournamentAccount", // 6047
  "MigrationNotNeeded", // 6048
  // ── V1.2 Oracle settlement (Stage C) ──────────────────────────────────────
  "MatchAlreadyCommitted", // 6049
  "MatchNotCommitted", // 6050
  "WrongFeedAccount", // 6051
  "OracleWinnerNotInMatch", // 6052
  "NotAuthorized", // 6053
  "BadProposalSource", // 6054
  // ── Stage D + H-1 / H-2 / L-2 hardening (appended) ────────────────────────
  "InvalidCustomPayout", // 6055
  "UntrustedMultiPlacementFinal", // 6056
  "BracketSeedMismatch", // 6057
  "NonParticipantInBracket", // 6058
  "InvalidOracleConfig", // 6059
  // ── Phase 1 closeout hardening (appended) ─────────────────────────────────
  "ParticipantRefundPending", // 6060
  "AbandonGraceNotElapsed", // 6061
  "NonCanonicalBump", // 6062
  "PlacementNotParticipant", // 6063
  "DuplicatePlacement", // 6064
  // ── R15 formats schema-prep (appended) ────────────────────────────────────
  "FormatNotYetSupported", // 6065
] as const;

type OnChainErrorName = (typeof ERRORS_RS_ORDER)[number];

/**
 * On-chain error name → factory producing the typed SDK error. Factories (not
 * raw constructors) so codes without a dedicated class can carry the program's
 * `#[msg]` text via `TransactionFailedError(message, cause)` while still
 * preserving `cause`. Every entry has signature `(cause?) => BracketChainSDKError`.
 */
const ON_CHAIN_TO_SDK: Record<
  OnChainErrorName,
  (cause?: unknown) => BracketChainSDKError
> = {
  UnauthorizedAuthority: (c) => new UnauthorizedReporterError(c),
  TournamentFull: (c) => new TournamentFullError(c),
  AlreadyRegistered: (c) => new AlreadyRegisteredError(c),
  RegistrationClosed: (c) => new RegistrationClosedError(c),
  NotInRegistration: (c) => new RegistrationClosedError(c),
  NotActive: (c) => new TournamentNotActiveError(c),
  NotCompleted: (c) =>
    new TransactionFailedError("Tournament is not in the Completed state", c),
  InvalidPayoutPreset: (c) => new InvalidPayoutPresetError(c),
  PresetExceedsParticipants: (c) => new InvalidPayoutPresetError(c),
  MatchAlreadyReported: (c) => new MatchAlreadyReportedError(c),
  NonParticipantWinner: (c) => new NonParticipantWinnerError(c),
  TournamentInProgress: (c) => new TournamentInProgressError(c),
  RefundAlreadyIssued: (c) =>
    new TransactionFailedError("Refund has already been issued to this participant", c),
  MaxParticipantsExceeded: (c) => new MaxParticipantsExceededError(c),
  MinParticipantsNotMet: (c) => new MinParticipantsNotMetError(c),
  NameTooLong: (c) => new NameTooLongError(c),
  InvalidTokenMint: (c) => new InvalidTokenMintError(c),
  InvalidVault: (c) =>
    new TransactionFailedError("Provided vault token account does not match the tournament vault", c),
  InvalidTreasury: (c) =>
    new TransactionFailedError("Provided treasury token account does not match the protocol treasury", c),
  InvalidMatchIndex: (c) => new InvalidMatchError(c),
  ParentMatchesNotComplete: (c) => new InvalidMatchError(c),
  RemainingAccountsMismatch: (c) =>
    new TransactionFailedError("remaining_accounts does not match the expected count for this instruction", c),
  ArithmeticOverflow: (c) => new TransactionFailedError("Arithmetic overflow", c),
  SlotHashesUnavailable: (c) =>
    new TransactionFailedError("slot_hashes sysvar is empty; cannot derive seed", c),
  // ── V1.1 game identity (SAS) ──────────────────────────────────────────────
  GameNotYetSupported: (c) => new GameNotSupportedError(c),
  AttestationRequired: (c) => new AttestationRequiredError(c),
  InvalidAttestationOwner: (c) => new InvalidAttestationError(c),
  WrongAttestationCredential: (c) => new InvalidAttestationError(c),
  WrongAttestationSchema: (c) => new InvalidAttestationError(c),
  AttestationWalletMismatch: (c) => new InvalidAttestationError(c),
  AttestationExpired: (c) => new InvalidAttestationError(c),
  MalformedAttestation: (c) => new InvalidAttestationError(c),
  // ── Player-reported / Oracle settlement (Stage B) ─────────────────────────
  SettlementModeMismatch: (c) => new SettlementModeError(c),
  NotPlayerInMatch: (c) =>
    new TransactionFailedError("Signer is not a player in this match", c),
  NotCounterparty: (c) =>
    new TransactionFailedError("Only the counterparty may confirm or dispute this proposal", c),
  NoProposal: (c) => new TransactionFailedError("Match has no pending proposal", c),
  ProposalAlreadyExists: (c) =>
    new TransactionFailedError("Match already has a pending proposal", c),
  InvalidProposedWinner: (c) => new NonParticipantWinnerError(c),
  ClaimWindowNotElapsed: (c) => new ClaimWindowNotElapsedError(c),
  ProposalDisputed: (c) =>
    new TransactionFailedError("Proposal is disputed; it cannot be claimed", c),
  ProposalNotDisputed: (c) =>
    new TransactionFailedError("Proposal is not disputed", c),
  // ── VRF seeding (Stage B) ─────────────────────────────────────────────────
  SeedNotRevealed: (c) => new SeedNotRevealedError(c),
  RandomnessNotResolved: (c) =>
    new TransactionFailedError("Switchboard randomness is not yet resolved for this slot", c),
  RandomnessAccountMismatch: (c) =>
    new TransactionFailedError("Provided randomness account does not match the tournament commitment", c),
  InvalidRandomnessOwner: (c) =>
    new TransactionFailedError("Randomness account is not owned by the Switchboard On-Demand program", c),
  MalformedRandomness: (c) =>
    new TransactionFailedError("Randomness account data is malformed", c),
  SeedAlreadyRevealed: (c) =>
    new TransactionFailedError("Tournament seed has already been revealed", c),
  InvalidTournamentAccount: (c) =>
    new TransactionFailedError("Account is not a Tournament owned by this program", c),
  MigrationNotNeeded: (c) =>
    new TransactionFailedError("Tournament account is already at the V1 layout; migration not needed", c),
  // ── V1.2 Oracle settlement (Stage C) ──────────────────────────────────────
  MatchAlreadyCommitted: (c) =>
    new TransactionFailedError("Match already has a lobby commitment", c),
  MatchNotCommitted: (c) =>
    new TransactionFailedError("Match has no lobby commitment; commit before binding a feed", c),
  WrongFeedAccount: (c) =>
    new TransactionFailedError("Switchboard feed account is not owned by the On-Demand program, or is on the wrong queue", c),
  OracleWinnerNotInMatch: (c) =>
    new TransactionFailedError("Oracle feed value did not match either committed player identity", c),
  NotAuthorized: (c) =>
    new TransactionFailedError("Signer is not authorized to dispute this Oracle proposal", c),
  BadProposalSource: (c) =>
    new TransactionFailedError("Proposal source is not valid for this action", c),
  // ── Stage D + H-1 / H-2 / L-2 hardening ───────────────────────────────────
  InvalidCustomPayout: (c) => new InvalidPayoutPresetError(c),
  UntrustedMultiPlacementFinal: (c) =>
    new TransactionFailedError("A multi-placement final may only be finalized by a trusted signer (settle_final / report_result / resolve_dispute)", c),
  BracketSeedMismatch: (c) =>
    new TransactionFailedError("Bracket descriptor is inconsistent with the VRF-derived seed permutation", c),
  NonParticipantInBracket: (c) => new NonParticipantWinnerError(c),
  InvalidOracleConfig: (c) =>
    new TransactionFailedError("Oracle config out of bounds (min_oracle_samples >= 1; max_stale_slots within ceiling)", c),
  // ── Phase 1 closeout hardening ────────────────────────────────────────────
  ParticipantRefundPending: (c) =>
    new TransactionFailedError("Participant has an unpaid refund; drive the refund chunk before closing this account", c),
  AbandonGraceNotElapsed: (c) =>
    new TransactionFailedError("Abandoned-tournament grace has not elapsed; only the organizer may cancel before registration_deadline + grace", c),
  NonCanonicalBump: (c) =>
    new TransactionFailedError("Match descriptor bump is not the canonical PDA bump", c),
  PlacementNotParticipant: (c) =>
    new TransactionFailedError("Placement wallet is not a registered Participant of this tournament", c),
  DuplicatePlacement: (c) =>
    new TransactionFailedError("Placements must be pairwise distinct", c),
  // ── R15 formats schema-prep ───────────────────────────────────────────────
  FormatNotYetSupported: (c) => new FormatNotYetSupportedError(c),
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
          const make = ON_CHAIN_TO_SDK[name];
          if (make) return make(err);
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

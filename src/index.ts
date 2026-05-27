// ─────────────────────────────────────────────────────────────────────────────
// Public surface of @bracketchain/sdk (0.4.x — Kit + Codama edition).
//
// Anything not re-exported here is internal and may change without a major bump.
// ─────────────────────────────────────────────────────────────────────────────

// Client
export { BracketChainClient } from "./client";
export type { BracketChainClientOptions } from "./client";

// PDA helpers — Codama-generated for declared accounts, hand-written for match.
export {
  findMatchPda,
  findParticipantPda,
  findProtocolConfigPda,
  findTournamentPda,
  findVaultPda,
} from "./pdas";
export type { MatchSeeds } from "./pdas";

// Codama-generated PDA seed types (re-exported so callers can spell them out).
export type {
  ParticipantSeeds,
  TournamentSeeds,
  VaultSeeds,
} from "./generated";

// Program address
export { BRACKET_CHAIN_PROGRAM_ADDRESS } from "./generated";

// Account + value types
export type {
  MatchInitDescriptor,
  MatchNode,
  MatchNodeWithAddress,
  Participant,
  ParticipantWithAddress,
  PlacementPayout,
  ProtocolConfig,
  Tournament,
  TournamentState,
  TournamentWithAddress,
  WithAddress,
} from "./types";

// Enums — exported as values so consumers can compare with `===`.
export {
  MatchStatus,
  PayoutPreset,
  ProposalSource,
  SettlementMode,
  SupportedGame,
  TournamentStatus,
} from "./types";

// Methods — reads + mutations
export {
  createTournament,
  cancelTournament,
  claimResult,
  confirmResult,
  disputeResult,
  forceClaimDisputed,
  getAllMatches,
  getMatch,
  getParticipant,
  getProtocolConfig,
  getTournament,
  getTournamentState,
  joinTournament,
  listParticipants,
  listTournaments,
  proposeResult,
  reportResult,
  requestSeed,
  resolveDispute,
  revealSeed,
  startTournament,
  subscribe,
} from "./methods";
export type {
  CancelTournamentParams,
  CancelTournamentResult,
  ClaimResultParams,
  ClaimResultResult,
  ConfirmResultParams,
  ConfirmResultResult,
  CreateTournamentConfig,
  CreateTournamentResult,
  DisputeResultParams,
  DisputeResultResult,
  ForceClaimDisputedParams,
  ForceClaimDisputedResult,
  JoinTournamentParams,
  JoinTournamentResult,
  ProposeResultParams,
  ProposeResultResult,
  ReportResultParams,
  ReportResultResult,
  RequestSeedParams,
  RequestSeedResult,
  ResolveDisputeParams,
  ResolveDisputeResult,
  RevealSeedParams,
  RevealSeedResult,
  StartTournamentParams,
  StartTournamentResult,
  SubscribeOptions,
  SubscriptionError,
  TournamentSubscriptionEvent,
} from "./methods";

// Indexer client — typed REST wrapper for the indexer service.
// Composes orthogonally with BracketChainClient.
export { BracketChainIndexerClient } from "./api";
export type {
  GetMatchesOptions,
  GetParticipantsOptions,
  GetPayoutsOptions,
  IndexerClientOptions,
  IndexerMatch,
  IndexerMatchStatus,
  IndexerParticipant,
  IndexerPayout,
  IndexerPayoutKind,
  IndexerPayoutPreset,
  IndexerProposalSource,
  IndexerSettlementMode,
  IndexerTournament,
  IndexerTournamentStatus,
  ListTournamentsOptions,
} from "./api";

// Errors — base class + every typed subclass + the mapError helper
export {
  AlreadyRegisteredError,
  BracketChainSDKError,
  InsufficientBalanceError,
  InsufficientFundsError,
  InvalidMatchError,
  InvalidPayoutPresetError,
  InvalidTokenMintError,
  MatchAlreadyReportedError,
  MaxParticipantsExceededError,
  MinParticipantsNotMetError,
  NameTooLongError,
  NonParticipantWinnerError,
  ProtocolNotInitializedError,
  RegistrationClosedError,
  TournamentFullError,
  TournamentInProgressError,
  TournamentNameTakenError,
  TournamentNotActiveError,
  TransactionFailedError,
  UnauthorizedReporterError,
  UnknownProgramError,
  mapError,
} from "./errors";

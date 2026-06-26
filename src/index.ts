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
  bindMatchFeed,
  commitMatchLobby,
  createTournament,
  cancelTournament,
  closeTournament,
  partialCancelTournament,
  partialRefundChunk,
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
  proposeResultOracle,
  reportResult,
  requestSeed,
  resolveDispute,
  revealSeed,
  setOracleConfig,
  settleFinal,
  startTournament,
  subscribe,
} from "./methods";
export type {
  BindMatchFeedParams,
  BindMatchFeedResult,
  CancelTournamentParams,
  CancelTournamentResult,
  CloseTournamentParams,
  CloseTournamentResult,
  PartialCancelTournamentParams,
  PartialCancelTournamentResult,
  PartialRefundChunkParams,
  PartialRefundChunkResult,
  ClaimResultParams,
  ClaimResultResult,
  CommitMatchLobbyParams,
  CommitMatchLobbyResult,
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
  ProposeResultOracleParams,
  ProposeResultOracleResult,
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
  SetOracleConfigParams,
  SetOracleConfigResult,
  SettleFinalParams,
  SettleFinalResult,
  StartTournamentParams,
  StartTournamentResult,
  SubscribeOptions,
  SubscriptionError,
  TournamentSubscriptionEvent,
} from "./methods";

// Oracle feed-job determinism artifacts (Phase 1.5). Like seeding.ts these
// reproduce bytes the program validates (`MatchCommitment.expected_feed_hash`
// in bind_match_feed) — protocol surface, not a service client.
export {
  buildDotaWinnerJobs,
  buildDotaWinnerUrl,
  computeDotaFeedHash,
} from "./oracle/dotaFeedJob";
export type {
  DotaFeedJobParams,
  DotaWinnerSource,
} from "./oracle/dotaFeedJob";
export {
  buildCs2WinnerJobs,
  buildCs2WinnerUrl,
  computeCs2FeedHash,
} from "./oracle/cs2FeedJob";
export type {
  Cs2FeedJobParams,
  Cs2WinnerSource,
} from "./oracle/cs2FeedJob";

// NOTE (2026-06-07): the indexer REST client (`BracketChainIndexerClient` +
// `Indexer*` types) moved OUT of the SDK into the frontend
// (`BracketChain-Frontend/lib/indexerClient.ts`). Layering rule: this SDK is
// PROTOCOL-ONLY — everything exported here must work against a bare Solana
// RPC node. Clients for services WE operate (indexer REST, oracle endpoints)
// are platform concerns and live with their consumers. Deterministic
// protocol artifacts (seeding.ts, oracle/dotaFeedJob.ts) stay here: they
// reproduce bytes the PROGRAM validates, regardless of who runs the servers.

// Errors — base class + every typed subclass + the mapError helper
export {
  AlreadyRegisteredError,
  AttestationRequiredError,
  BracketChainSDKError,
  ClaimWindowNotElapsedError,
  FormatNotYetSupportedError,
  GameNotSupportedError,
  InsufficientBalanceError,
  InsufficientFundsError,
  InvalidAttestationError,
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
  SeedNotRevealedError,
  SettlementModeError,
  TournamentFullError,
  TournamentInProgressError,
  TournamentNameTakenError,
  TournamentNotActiveError,
  TransactionFailedError,
  UnauthorizedReporterError,
  UnknownProgramError,
  mapError,
} from "./errors";

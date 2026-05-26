// Read-only queries
export {
  getMatch,
  getParticipant,
  getProtocolConfig,
  getTournament,
  getTournamentState,
  getAllMatches,
  listParticipants,
  listTournaments,
} from "./queries";

// Mutations
export { createTournament } from "./createTournament";
export type {
  CreateTournamentConfig,
  CreateTournamentResult,
} from "./createTournament";

export { joinTournament } from "./joinTournament";
export type {
  JoinTournamentParams,
  JoinTournamentResult,
} from "./joinTournament";

export { cancelTournament } from "./cancelTournament";
export type {
  CancelTournamentParams,
  CancelTournamentResult,
} from "./cancelTournament";

export { startTournament } from "./startTournament";
export type {
  StartTournamentParams,
  StartTournamentResult,
} from "./startTournament";

export { reportResult } from "./reportResult";
export type {
  ReportResultParams,
  ReportResultResult,
} from "./reportResult";

// ── Player-reported settlement (Stage B) ────────────────────────────────────
export { proposeResult } from "./proposeResult";
export type {
  ProposeResultParams,
  ProposeResultResult,
} from "./proposeResult";

export { confirmResult } from "./confirmResult";
export type {
  ConfirmResultParams,
  ConfirmResultResult,
} from "./confirmResult";

export { disputeResult } from "./disputeResult";
export type {
  DisputeResultParams,
  DisputeResultResult,
} from "./disputeResult";

export { claimResult } from "./claimResult";
export type { ClaimResultParams, ClaimResultResult } from "./claimResult";

export { resolveDispute } from "./resolveDispute";
export type {
  ResolveDisputeParams,
  ResolveDisputeResult,
} from "./resolveDispute";

export { forceClaimDisputed } from "./forceClaimDisputed";
export type {
  ForceClaimDisputedParams,
  ForceClaimDisputedResult,
} from "./forceClaimDisputed";

// ── VRF seeding (Stage B) ───────────────────────────────────────────────────
export { requestSeed } from "./requestSeed";
export type { RequestSeedParams, RequestSeedResult } from "./requestSeed";

export { revealSeed } from "./revealSeed";
export type { RevealSeedParams, RevealSeedResult } from "./revealSeed";

export { subscribe } from "./subscribe";
export type {
  SubscribeOptions,
  SubscriptionError,
  TournamentSubscriptionEvent,
} from "./subscribe";

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

export { subscribe } from "./subscribe";
export type {
  SubscribeOptions,
  SubscriptionError,
  TournamentSubscriptionEvent,
} from "./subscribe";

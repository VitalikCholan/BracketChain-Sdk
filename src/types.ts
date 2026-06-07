import type { Address } from "@solana/kit";

// ─────────────────────────────────────────────────────────────────────────────
// Account + value types — re-exported from Codama-generated client.
// ─────────────────────────────────────────────────────────────────────────────

export type {
  MatchNode,
  Participant,
  ProtocolConfig,
  Tournament,
} from "./generated";

export {
  MatchStatus,
  PayoutPreset,
  ProposalSource,
  SettlementMode,
  SupportedGame,
  TournamentFormat,
  TournamentStatus,
} from "./generated";

export type {
  MatchInitDescriptor,
  PlacementPayout,
} from "./generated";

// ─────────────────────────────────────────────────────────────────────────────
// `WithAddress<T>` — pair any account with its on-chain address. Returned by
// list-style queries so callers can route to `/t/[address]` without
// recomputing PDAs.
// ─────────────────────────────────────────────────────────────────────────────

export interface WithAddress<T> {
  address: Address;
  account: T;
}

import type { MatchNode, Participant, Tournament } from "./generated";

export type TournamentWithAddress = WithAddress<Tournament>;
export type MatchNodeWithAddress = WithAddress<MatchNode>;
export type ParticipantWithAddress = WithAddress<Participant>;

// ─────────────────────────────────────────────────────────────────────────────
// Composite read shape — returned by getTournamentState(pda).
// Bundles the three things every UI page needs in one Promise.all.
// ─────────────────────────────────────────────────────────────────────────────

export interface TournamentState {
  address: Address;
  tournament: Tournament;
  bracket: MatchNodeWithAddress[];
  participants: ParticipantWithAddress[];
}

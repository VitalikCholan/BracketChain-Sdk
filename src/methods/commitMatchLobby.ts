import {
  type Address,
  type ReadonlyUint8Array,
  type Signature,
} from "@solana/kit";

import type { BracketChainClient } from "../client";
import {
  findParticipantPda,
  getCommitMatchLobbyInstruction,
} from "../generated";
import { findMatchPda } from "../pdas";
import { assertSigner, sendInstructions } from "./_send";

export interface CommitMatchLobbyParams {
  tournamentPda: Address;
  /** 0-indexed round of the match. */
  round: number;
  /** 0-indexed match position within the round. */
  matchIndex: number;
  /** Bracket lane (C9). Single-elim V1 = 0. */
  bracket?: number;
  /** Wallet address occupying the match's `playerA` slot. */
  playerA: Address;
  /** Wallet address occupying the match's `playerB` slot. */
  playerB: Address;
  /** 16-byte lobby identifier negotiated with the game backend. */
  lobbyId: ReadonlyUint8Array;
  /** 32-byte hash the Switchboard feed bound later must match. */
  expectedFeedHash: ReadonlyUint8Array;
}

export interface CommitMatchLobbyResult {
  txSignature: Signature;
}

/**
 * Organizer (Stage C / V1.2): commit a match to a game lobby before launch.
 * Records the lobby id + expected feed hash on the match account; must be
 * called before `bindMatchFeed` and `proposeResultOracle`.
 */
export async function commitMatchLobby(
  client: BracketChainClient,
  params: CommitMatchLobbyParams,
): Promise<CommitMatchLobbyResult> {
  const signer = assertSigner(client, "commitMatchLobby");
  const [matchPda] = await findMatchPda({
    tournament: params.tournamentPda,
    bracket: params.bracket ?? 0,
    round: params.round,
    matchIndex: params.matchIndex,
  });
  const [participantAPda] = await findParticipantPda({
    tournament: params.tournamentPda,
    player: params.playerA,
  });
  const [participantBPda] = await findParticipantPda({
    tournament: params.tournamentPda,
    player: params.playerB,
  });

  const ix = getCommitMatchLobbyInstruction({
    organizer: signer,
    tournament: params.tournamentPda,
    matchAccount: matchPda,
    participantA: participantAPda,
    participantB: participantBPda,
    lobbyId: params.lobbyId,
    expectedFeedHash: params.expectedFeedHash,
  });

  const txSignature = await sendInstructions(client, signer, [ix]);
  return { txSignature };
}

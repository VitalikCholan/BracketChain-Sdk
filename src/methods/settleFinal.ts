import {
  type Address,
  type Instruction,
  type Signature,
} from "@solana/kit";

import type { BracketChainClient } from "../client";
import { getSettleFinalInstructionAsync } from "../generated";
import { buildFinalizeContext } from "./_finalize";
import { assertSigner, sendInstructions } from "./_send";

export interface SettleFinalParams {
  tournamentPda: Address;
  /** 0-indexed round of the final match. */
  round: number;
  /** 0-indexed match position within the round — the final is always 0. */
  matchIndex: number;
  /** Bracket lane (C9). Single-elim V1 = 0. */
  bracket?: number;
  /**
   * Placements per the payout preset (length must equal its placement_count).
   * Position 0 must equal the proposed winner; position 1 the final's loser;
   * positions 2+ are the arbitrator's adjudication of the lower placements.
   */
  placements: Address[];
}

export interface SettleFinalResult {
  txSignature: Signature;
  isFinal: boolean;
}

/**
 * Arbitrator-signed settlement of a **multi-placement (non-WinnerTakesAll)
 * final** — the trusted sibling of `claimResult` (H-1). Preconditions mirror
 * `claimResult` exactly: an **undisputed** proposal whose dispute window has
 * elapsed. The winner stays pinned to the trustless `proposedWinner`; the
 * arbitrator only adjudicates placements 2+ — it cannot change the result.
 *
 * Routing cheat-sheet:
 *  - WinnerTakesAll final → permissionless `claimResult` (no arbitrator).
 *  - Multi-placement final, undisputed → THIS method (arbitrator-signed).
 *  - Disputed final (any preset) → `resolveDispute` (arbitrator picks winner).
 *
 * The signer must be `tournament.arbitrator` (defaults to the organizer at
 * create-time; Squads-multisig reassignment is V1.3).
 */
export async function settleFinal(
  client: BracketChainClient,
  params: SettleFinalParams,
): Promise<SettleFinalResult> {
  const signer = assertSigner(client, "settleFinal");
  const ctx = await buildFinalizeContext(client, {
    tournamentPda: params.tournamentPda,
    round: params.round,
    matchIndex: params.matchIndex,
    bracket: params.bracket,
    placements: params.placements,
    payer: signer,
  });

  const baseIx = await getSettleFinalInstructionAsync({
    arbitrator: signer,
    tournament: params.tournamentPda,
    matchAccount: ctx.matchPda,
    nextMatch: ctx.nextMatch,
    participantA: ctx.participantA,
    participantB: ctx.participantB,
    placements: params.placements,
  });
  const ix: Instruction = {
    ...baseIx,
    accounts: [...(baseIx.accounts ?? []), ...ctx.remainingAccounts],
  };

  const txSignature = await sendInstructions(client, signer, [
    ...ctx.ataInstructions,
    ix,
  ]);
  return { txSignature, isFinal: ctx.isFinal };
}

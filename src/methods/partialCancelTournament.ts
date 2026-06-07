import {
  AccountRole,
  type Address,
  type Instruction,
  type Signature,
} from "@solana/kit";

import type { BracketChainClient } from "../client";
import {
  mapError,
  TournamentNotActiveError,
  UnauthorizedReporterError,
} from "../errors";
import {
  BRACKET_CHAIN_PROGRAM_ADDRESS,
  fetchTournament,
  TournamentStatus,
  type Tournament,
} from "../generated";
import { assertSigner, sendInstructions } from "./_send";

// Anchor `global:partial_cancel_tournament` discriminator (sha256(...)[..8]).
const PARTIAL_CANCEL_TOURNAMENT_DISCRIMINATOR = new Uint8Array([
  194, 241, 74, 25, 111, 229, 230, 141,
]);

export interface PartialCancelTournamentParams {
  tournamentPda: Address;
}

export interface PartialCancelTournamentResult {
  txSignature: Signature;
}

/**
 * Organizer-signed mid-tournament cancellation (Stage E, E-2 / gate G8).
 *
 * Callable only while the tournament is `Active`; flips status to
 * `PartialCancelled` and freezes the bracket. Refunds are then driven
 * permissionlessly by {@link partialRefundChunk} (Policy A: every participant
 * is refunded their full entry fee; the organizer recovers only their deposit —
 * cancelling is a pure loss, never a profit).
 *
 * Hand-built instruction — the codama client gains `getPartialCancelTournament…`
 * at the Stage F regen; until then this method owns the discriminator + layout.
 */
export async function partialCancelTournament(
  client: BracketChainClient,
  params: PartialCancelTournamentParams,
): Promise<PartialCancelTournamentResult> {
  const signer = assertSigner(client, "partialCancelTournament");
  const tournamentPda = params.tournamentPda;

  // ── read tournament + validate (clean error before a wasted tx fee) ───────
  let tournament: Tournament;
  try {
    tournament = (await fetchTournament(client.rpc, tournamentPda)).data;
  } catch (err) {
    throw mapError(err);
  }

  // The program requires `Active`; surface a clear client-side error otherwise.
  if (tournament.status !== TournamentStatus.Active) {
    throw new TournamentNotActiveError();
  }
  if (tournament.organizer !== signer.address) {
    throw new UnauthorizedReporterError();
  }

  const ix: Instruction = {
    programAddress: BRACKET_CHAIN_PROGRAM_ADDRESS,
    accounts: [
      { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: tournamentPda, role: AccountRole.WRITABLE },
    ],
    data: PARTIAL_CANCEL_TOURNAMENT_DISCRIMINATOR,
  };

  const txSignature = await sendInstructions(client, signer, [ix]);
  return { txSignature };
}

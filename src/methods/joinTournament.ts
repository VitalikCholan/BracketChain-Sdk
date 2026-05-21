import { type Address, type Signature } from "@solana/kit";
import {
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

import type { BracketChainClient } from "../client";
import {
  AlreadyRegisteredError,
  InsufficientBalanceError,
  isAccountAlreadyInitialized,
  mapError,
  RegistrationClosedError,
  TournamentFullError,
} from "../errors";
import {
  fetchTournament,
  findParticipantPda,
  findVaultPda,
  getJoinTournamentInstructionAsync,
  TournamentStatus,
} from "../generated";
import { assertSigner, sendInstructions } from "./_send";

export interface JoinTournamentParams {
  /** PDA address of the tournament to join. */
  tournamentPda: Address;
}

export interface JoinTournamentResult {
  /** Derived Participant PDA — useful for follow-up reads/refunds. */
  participantPda: Address;
  /** Transaction signature, confirmed at the client's commitment. */
  txSignature: Signature;
}

/**
 * Register the connected wallet for an open tournament.
 *
 * Pre-flight:
 *  - status must be `Registration`
 *  - now < registration_deadline
 *  - participant_count < max_participants
 *  - player's token-account balance ≥ entry_fee (creates the ATA in-tx if
 *    missing, in which case balance is 0 → throws InsufficientBalanceError
 *    before sending)
 */
export async function joinTournament(
  client: BracketChainClient,
  params: JoinTournamentParams,
): Promise<JoinTournamentResult> {
  const signer = assertSigner(client, "joinTournament");
  const player = signer.address;
  const tournamentPda = params.tournamentPda;

  // ── read tournament + validate ────────────────────────────────────────────
  let tournament;
  try {
    tournament = (await fetchTournament(client.rpc, tournamentPda)).data;
  } catch (err) {
    throw mapError(err);
  }

  if (tournament.status !== TournamentStatus.Registration) {
    throw new RegistrationClosedError();
  }

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (nowSec >= tournament.registrationDeadline) {
    throw new RegistrationClosedError();
  }
  if (tournament.participantCount >= tournament.maxParticipants) {
    throw new TournamentFullError();
  }

  const [participantPda] = await findParticipantPda({
    tournament: tournamentPda,
    player,
  });
  const [vaultPda] = await findVaultPda({ tournament: tournamentPda });
  const [playerAta] = await findAssociatedTokenPda({
    owner: player,
    mint: tournament.tokenMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  // ── ATA: create idempotently + balance pre-check ──────────────────────────
  const preInstructions = [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: signer,
      owner: player,
      mint: tournament.tokenMint,
      ata: playerAta,
    }),
  ];

  let playerBalance = 0n;
  try {
    const ataAccount = await fetchMaybeToken(client.rpc, playerAta);
    if (ataAccount.exists) {
      playerBalance = ataAccount.data.amount;
    }
  } catch (err) {
    throw mapError(err);
  }

  if (playerBalance < tournament.entryFee) {
    throw new InsufficientBalanceError();
  }

  const joinIx = await getJoinTournamentInstructionAsync({
    player: signer,
    tournament: tournamentPda,
    participant: participantPda,
    playerTokenAccount: playerAta,
    vault: vaultPda,
  });

  try {
    const txSignature = await sendInstructions(client, signer, [
      ...preInstructions,
      joinIx,
    ]);
    return { participantPda, txSignature };
  } catch (err) {
    // Anchor `init` collision on Participant PDA → already registered.
    if (isAccountAlreadyInitialized(err)) {
      throw new AlreadyRegisteredError(err);
    }
    throw err instanceof Error ? mapError(err) : err;
  }
}

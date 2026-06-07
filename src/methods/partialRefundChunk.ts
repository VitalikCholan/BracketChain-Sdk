import {
  AccountRole,
  type AccountMeta,
  type Address,
  type Instruction,
  type Signature,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

import type { BracketChainClient } from "../client";
import { mapError, TournamentInProgressError } from "../errors";
import {
  BRACKET_CHAIN_PROGRAM_ADDRESS,
  fetchTournament,
  findParticipantPda,
  findVaultPda,
  TournamentStatus,
  type Tournament,
} from "../generated";
import { assertSigner, sendInstructions } from "./_send";
import { listParticipants } from "./queries";

// Anchor `global:partial_refund_chunk` discriminator.
const PARTIAL_REFUND_DISCRIMINATOR = new Uint8Array([
  145, 61, 45, 143, 170, 57, 149, 244,
]);

const DEFAULT_CHUNK_SIZE = 24;

export interface PartialRefundChunkParams {
  tournamentPda: Address;
  /** Explicit wallets; if omitted, every not-yet-refunded participant is fetched. */
  participantWallets?: Address[];
  /** Refund pairs per tx. Default 24. */
  chunkSize?: number;
}

export interface PartialRefundChunkResult {
  txSignatures: Signature[];
  refundsSubmitted: number;
}

/**
 * Process refunds for a partially-cancelled tournament (Stage E, E-3 / gate
 * G8). **Policy A — full refund to all:** every participant is refunded their
 * full entry fee; the organizer recovers only their deposit. Permissionless and
 * idempotent (the program skips `refund_paid` participants). Requires the
 * tournament to be in `PartialCancelled` (set by `partialCancelTournament`).
 *
 * Hand-built instruction — the codama client gains `getPartialRefundChunk…` at
 * the Stage F regen; until then this method owns the discriminator + layout.
 */
export async function partialRefundChunk(
  client: BracketChainClient,
  params: PartialRefundChunkParams,
): Promise<PartialRefundChunkResult> {
  const signer = assertSigner(client, "partialRefundChunk");
  const tournamentPda = params.tournamentPda;

  let tournament: Tournament;
  try {
    tournament = (await fetchTournament(client.rpc, tournamentPda)).data;
  } catch (err) {
    throw mapError(err);
  }
  if (tournament.status !== TournamentStatus.Cancelled) {
    // The generated enum has no `PartialCancelled` until the Stage F regen; the
    // on-chain program enforces the real `PartialCancelled` gate, so a stale
    // generated enum here would only mis-message. Skip the client-side check
    // when the variant is unknown, but keep a guard for clearly-wrong states.
    if (
      tournament.status === TournamentStatus.Registration ||
      tournament.status === TournamentStatus.PendingBracketInit
    ) {
      throw new TournamentInProgressError();
    }
  }

  const [vaultPda] = await findVaultPda({ tournament: tournamentPda });

  // Organizer-deposit return: carried on the first chunk only.
  const depositPending =
    tournament.organizerDeposit > 0n && !tournament.organizerDepositRefunded;
  let organizerAta: Address | undefined;
  const ataPreInstructions = [];
  if (depositPending) {
    const [ata] = await findAssociatedTokenPda({
      owner: tournament.organizer,
      mint: tournament.tokenMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    organizerAta = ata;
    ataPreInstructions.push(
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: signer,
        owner: tournament.organizer,
        mint: tournament.tokenMint,
        ata,
      }),
    );
  }

  const pairs = await resolvePairs(client, tournamentPda, tournament, params);

  const buildIx = (
    pairChunk: Array<readonly [Address, Address]>,
    withOrganizerAta: boolean,
  ): Instruction => {
    const remaining: AccountMeta[] = pairChunk.flatMap(([pda, ata]) => [
      { address: pda, role: AccountRole.WRITABLE },
      { address: ata, role: AccountRole.WRITABLE },
    ]);
    // Anchor optional account: present → writable; None → the program address
    // as a readonly placeholder (the codama "programId" fallback strategy).
    const organizerSlot: AccountMeta =
      withOrganizerAta && organizerAta
        ? { address: organizerAta, role: AccountRole.WRITABLE }
        : { address: BRACKET_CHAIN_PROGRAM_ADDRESS, role: AccountRole.READONLY };
    return {
      programAddress: BRACKET_CHAIN_PROGRAM_ADDRESS,
      accounts: [
        { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
        { address: tournamentPda, role: AccountRole.WRITABLE },
        { address: vaultPda, role: AccountRole.WRITABLE },
        organizerSlot,
        { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
        ...remaining,
      ],
      data: PARTIAL_REFUND_DISCRIMINATOR,
    };
  };

  // Deposit-only call (no participant pairs left) still needs to run once.
  if (pairs.length === 0) {
    if (!depositPending) {
      return { txSignatures: [], refundsSubmitted: 0 };
    }
    const sig = await sendInstructions(client, signer, [
      ...ataPreInstructions,
      buildIx([], true),
    ]);
    return { txSignatures: [sig], refundsSubmitted: 0 };
  }

  const chunkSize = Math.max(1, Math.min(params.chunkSize ?? DEFAULT_CHUNK_SIZE, 32));
  const txSignatures: Signature[] = [];
  for (let i = 0; i < pairs.length; i += chunkSize) {
    const isFirst = i === 0;
    const ix = buildIx(pairs.slice(i, i + chunkSize), isFirst);
    const sig = await sendInstructions(
      client,
      signer,
      isFirst && ataPreInstructions.length > 0 ? [...ataPreInstructions, ix] : [ix],
    );
    txSignatures.push(sig);
  }

  return { txSignatures, refundsSubmitted: pairs.length };
}

async function resolvePairs(
  client: BracketChainClient,
  tournamentPda: Address,
  tournament: Tournament,
  params: PartialRefundChunkParams,
): Promise<Array<readonly [Address, Address]>> {
  if (params.participantWallets && params.participantWallets.length > 0) {
    return await Promise.all(
      params.participantWallets.map(async (wallet) => {
        const [pda] = await findParticipantPda({ tournament: tournamentPda, player: wallet });
        const [ata] = await findAssociatedTokenPda({
          owner: wallet,
          mint: tournament.tokenMint,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        });
        return [pda, ata] as const;
      }),
    );
  }
  const all = await listParticipants(client, tournamentPda);
  const pending = all.filter((entry) => !entry.account.refundPaid);
  return await Promise.all(
    pending.map(async (entry) => {
      const [ata] = await findAssociatedTokenPda({
        owner: entry.account.wallet,
        mint: tournament.tokenMint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      return [entry.address, ata] as const;
    }),
  );
}

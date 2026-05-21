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
import {
  mapError,
  TournamentInProgressError,
  UnauthorizedReporterError,
} from "../errors";
import {
  fetchTournament,
  findParticipantPda,
  findVaultPda,
  getCancelTournamentInstructionAsync,
  TournamentStatus,
  type Tournament,
} from "../generated";
import { assertSigner, sendInstructions } from "./_send";
import { listParticipants } from "./queries";

// ─────────────────────────────────────────────────────────────────────────────
// Tx-budget chunking — see notes in the original SDK. Matches the on-chain
// handler's accepted shape: pairs of [participant_pda, ata] in `remaining_accounts`.
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_CHUNK_SIZE = 24;

export interface CancelTournamentParams {
  tournamentPda: Address;
  /**
   * Explicit wallet list. If omitted, the SDK fetches every Participant for
   * this tournament and filters out already-refunded ones.
   */
  participantWallets?: Address[];
  /** Refund pairs per tx. Default 24. */
  chunkSize?: number;
}

export interface CancelTournamentResult {
  /** One signature per chunk, in send order. */
  txSignatures: Signature[];
  /** Number of [pda, ata] pairs submitted across all chunks. */
  refundsSubmitted: number;
  /** True when this call (or a prior one) flipped status to Cancelled. */
  statusFlipped: boolean;
}

/**
 * Cancel a tournament and refund participants.
 *
 * Two-phase semantics, mirrored from the on-chain handler:
 *  - First call (status ≠ Cancelled): only the organizer may invoke. Flips
 *    status to Cancelled and processes the supplied refund pairs.
 *  - Subsequent calls (status = Cancelled): any signer may invoke. Idempotent —
 *    already-refunded participants are skipped on-chain by `refund_paid` flag.
 */
export async function cancelTournament(
  client: BracketChainClient,
  params: CancelTournamentParams,
): Promise<CancelTournamentResult> {
  const signer = assertSigner(client, "cancelTournament");
  const caller = signer.address;
  const tournamentPda = params.tournamentPda;

  // ── read tournament + validate ────────────────────────────────────────────
  let tournament: Tournament;
  try {
    tournament = (await fetchTournament(client.rpc, tournamentPda)).data;
  } catch (err) {
    throw mapError(err);
  }

  const isCancellable =
    tournament.status === TournamentStatus.Registration ||
    tournament.status === TournamentStatus.PendingBracketInit ||
    tournament.status === TournamentStatus.Cancelled;
  if (!isCancellable) {
    throw new TournamentInProgressError();
  }

  // First-call auth check — saves a wasted tx fee + clearer error message.
  if (
    tournament.status !== TournamentStatus.Cancelled &&
    tournament.organizer !== caller
  ) {
    throw new UnauthorizedReporterError();
  }

  const [vaultPda] = await findVaultPda({ tournament: tournamentPda });

  // ── organizer-deposit refund prep ─────────────────────────────────────────
  const organizerDepositRefundPending =
    tournament.organizerDeposit > 0n && !tournament.organizerDepositRefunded;

  let organizerAta: Address | undefined;
  const ataPreInstructions = [];

  if (organizerDepositRefundPending) {
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

  // ── resolve refund pairs ──────────────────────────────────────────────────
  const pairs = await resolveRefundPairs(
    client,
    tournamentPda,
    tournament,
    params,
  );

  // ── nothing-to-refund branch (still flip status / refund deposit) ─────────
  if (pairs.length === 0) {
    if (
      tournament.status === TournamentStatus.Cancelled &&
      !organizerDepositRefundPending
    ) {
      return { txSignatures: [], refundsSubmitted: 0, statusFlipped: false };
    }
    const ix = await getCancelTournamentInstructionAsync({
      caller: signer,
      tournament: tournamentPda,
      vault: vaultPda,
      organizerTokenAccount: organizerAta,
    });
    const sig = await sendInstructions(client, signer, [
      ...ataPreInstructions,
      ix,
    ]);
    return { txSignatures: [sig], refundsSubmitted: 0, statusFlipped: true };
  }

  // ── chunk + send sequentially ────────────────────────────────────────────
  const chunkSize = Math.max(
    1,
    Math.min(params.chunkSize ?? DEFAULT_CHUNK_SIZE, 32),
  );
  const chunks: Array<Array<readonly [Address, Address]>> = [];
  for (let i = 0; i < pairs.length; i += chunkSize) {
    chunks.push(pairs.slice(i, i + chunkSize));
  }

  const txSignatures: Signature[] = [];
  let statusFlipped = tournament.status === TournamentStatus.Cancelled;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const isFirstChunk = i === 0;
    const remainingAccounts: AccountMeta[] = chunk.flatMap(([pda, ata]) => [
      { address: pda, role: AccountRole.WRITABLE },
      { address: ata, role: AccountRole.WRITABLE },
    ]);

    const baseIx = await getCancelTournamentInstructionAsync({
      caller: signer,
      tournament: tournamentPda,
      vault: vaultPda,
      organizerTokenAccount: isFirstChunk ? organizerAta : undefined,
    });
    const ix: Instruction = {
      ...baseIx,
      accounts: [...(baseIx.accounts ?? []), ...remainingAccounts],
    };

    const sig = await sendInstructions(
      client,
      signer,
      isFirstChunk && ataPreInstructions.length > 0
        ? [...ataPreInstructions, ix]
        : [ix],
    );
    txSignatures.push(sig);
    statusFlipped = true;
  }

  return { txSignatures, refundsSubmitted: pairs.length, statusFlipped };
}

async function resolveRefundPairs(
  client: BracketChainClient,
  tournamentPda: Address,
  tournament: Tournament,
  params: CancelTournamentParams,
): Promise<Array<readonly [Address, Address]>> {
  if (params.participantWallets && params.participantWallets.length > 0) {
    return await Promise.all(
      params.participantWallets.map(async (wallet) => {
        const [pda] = await findParticipantPda({
          tournament: tournamentPda,
          player: wallet,
        });
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

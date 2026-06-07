import {
  AccountRole,
  type AccountMeta,
  type Address,
  type Instruction,
  type Signature,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import type { BracketChainClient } from "../client";
import { mapError, TournamentInProgressError } from "../errors";
import {
  BRACKET_CHAIN_PROGRAM_ADDRESS,
  fetchTournament,
  findVaultPda,
  TournamentStatus,
  type Tournament,
} from "../generated";
import { assertSigner, sendInstructions } from "./_send";

// Anchor `global:close_tournament` discriminator (sha256(...)[..8]).
const CLOSE_TOURNAMENT_DISCRIMINATOR = new Uint8Array([
  14, 80, 54, 9, 221, 239, 201, 35,
]);

// Child PDAs (MatchNode | Participant) closed per tx. Each is a single
// writable account in `remaining_accounts`; the on-chain handler closes ~10+
// comfortably within the CU/account budget.
const DEFAULT_CHUNK_SIZE = 20;

export interface CloseTournamentParams {
  tournamentPda: Address;
  /**
   * Child PDAs (MatchNode + Participant) to close, in any order. The handler
   * skips already-closed accounts, so re-sending a chunk is safe.
   */
  childPdas: Address[];
  /**
   * When true, a final call closes the vault + Tournament PDA itself (requires
   * an empty vault). Sent AFTER all child chunks so no child rent is orphaned.
   */
  closeRoot?: boolean;
  /** Child PDAs per tx. Default 20. */
  chunkSize?: number;
}

export interface CloseTournamentResult {
  /** One signature per chunk (+ the root-close call), in send order. */
  txSignatures: Signature[];
  /** Number of child PDAs submitted across all chunks. */
  childrenSubmitted: number;
  /** True when the root-close (vault + Tournament PDA) call was sent. */
  rootClosed: boolean;
}

/**
 * Permissionless rent reclaim for a terminal tournament (Stage D, D-3 / gate
 * G7). Closes the supplied child PDAs in CU-budget chunks; all reclaimed rent
 * flows to the original organizer on-chain regardless of who signs. When
 * `closeRoot` is set, a final call closes the vault + Tournament PDA.
 *
 * Minimal hand-built instruction — the codama-generated client gains
 * `getCloseTournamentInstruction` at the Stage F regen (F-4/F-5); until then
 * this method owns the discriminator + account layout.
 */
export async function closeTournament(
  client: BracketChainClient,
  params: CloseTournamentParams,
): Promise<CloseTournamentResult> {
  const signer = assertSigner(client, "closeTournament");
  const tournamentPda = params.tournamentPda;

  let tournament: Tournament;
  try {
    tournament = (await fetchTournament(client.rpc, tournamentPda)).data;
  } catch (err) {
    throw mapError(err);
  }

  const isTerminal =
    tournament.status === TournamentStatus.Completed ||
    tournament.status === TournamentStatus.Cancelled;
  if (!isTerminal) {
    throw new TournamentInProgressError();
  }

  const [vaultPda] = await findVaultPda({ tournament: tournamentPda });

  const buildIx = (
    remaining: AccountMeta[],
    closeRoot: boolean,
  ): Instruction => ({
    programAddress: BRACKET_CHAIN_PROGRAM_ADDRESS,
    accounts: [
      { address: signer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: tournamentPda, role: AccountRole.WRITABLE },
      { address: tournament.organizer, role: AccountRole.WRITABLE },
      { address: vaultPda, role: AccountRole.WRITABLE },
      { address: TOKEN_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      ...remaining,
    ],
    data: new Uint8Array([
      ...CLOSE_TOURNAMENT_DISCRIMINATOR,
      closeRoot ? 1 : 0,
    ]),
  });

  const chunkSize = Math.max(1, Math.min(params.chunkSize ?? DEFAULT_CHUNK_SIZE, 30));
  const txSignatures: Signature[] = [];

  for (let i = 0; i < params.childPdas.length; i += chunkSize) {
    const remaining: AccountMeta[] = params.childPdas
      .slice(i, i + chunkSize)
      .map((address) => ({ address, role: AccountRole.WRITABLE }));
    txSignatures.push(
      await sendInstructions(client, signer, [buildIx(remaining, false)]),
    );
  }

  let rootClosed = false;
  if (params.closeRoot) {
    txSignatures.push(await sendInstructions(client, signer, [buildIx([], true)]));
    rootClosed = true;
  }

  return {
    txSignatures,
    childrenSubmitted: params.childPdas.length,
    rootClosed,
  };
}

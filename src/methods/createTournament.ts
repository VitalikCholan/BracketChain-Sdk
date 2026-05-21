import {
  type Address,
  type Signature,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

import type { BracketChainClient } from "../client";
import {
  BracketChainSDKError,
  InvalidPayoutPresetError,
  isAccountAlreadyInitialized,
  MaxParticipantsExceededError,
  MinParticipantsNotMetError,
  NameTooLongError,
  ProtocolNotInitializedError,
  RegistrationClosedError,
  TournamentNameTakenError,
  mapError,
} from "../errors";
import {
  fetchMaybeProtocolConfig,
  fetchMaybeTournament,
  findProtocolConfigPda,
  findTournamentPda,
  findVaultPda,
  getCreateTournamentInstructionAsync,
  PayoutPreset,
} from "../generated";
import { assertSigner, sendInstructions } from "./_send";

// On-chain bounds — must mirror `bracket-chain-programs/src/constants.rs`.
const MAX_TOURNAMENT_NAME_BYTES = 32;
const MIN_PARTICIPANTS = 2;
const MAX_PARTICIPANTS = 128;

// Per-preset minimum players. Mirrors `PayoutPreset::min_participants()`.
const PRESET_MIN_PARTICIPANTS: Record<PayoutPreset, number> = {
  [PayoutPreset.WinnerTakesAll]: 1,
  [PayoutPreset.Standard]: 3,
  [PayoutPreset.Deep]: 7,
};

export interface CreateTournamentConfig {
  /** UTF-8 name, ≤32 bytes (not characters). Used in the tournament PDA seed. */
  name: string;
  /** Entry fee in token's base units (u64). For 6-decimal USDC, 1 USDC = 1_000_000. */
  entryFee: bigint | number;
  /** Hard cap, [2, 128]. Bracket size derives from this at start time. */
  maxParticipants: number;
  /** Payout preset — Codama enum `PayoutPreset.{WinnerTakesAll,Standard,Deep}`. */
  payoutPreset: PayoutPreset;
  /** Unix timestamp (seconds). Must be strictly greater than the on-chain clock at submit time. */
  registrationDeadline: bigint | number;
  /**
   * SPL Token mint for entry fees + prize pool. Defaults to
   * `ProtocolConfig.defaultMint` (advisory canonical mint, e.g. USDC).
   */
  tokenMint?: Address;
  /**
   * Optional organizer top-up to the prize pool, in token base units.
   * Defaults to `0`. When > 0, the SDK auto-creates the organizer's ATA (if
   * missing) and transfers the deposit into the vault on the same tx.
   */
  organizerDeposit?: bigint | number;
}

export interface CreateTournamentResult {
  tournamentPda: Address;
  vaultPda: Address;
  txSignature: Signature;
}

function toBigInt(value: bigint | number, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (Number.isInteger(value)) return BigInt(value);
  throw new BracketChainSDKError(
    `Expected integer/bigint for ${field}, got ${typeof value} (${String(value)})`,
    "InvalidArgument",
  );
}

/**
 * Create a new tournament on-chain.
 *
 * Pre-flight validation mirrors the program's `require!` checks so we fail
 * fast in the browser instead of paying tx fees:
 *  - name UTF-8 byte length ≤ 32
 *  - 2 ≤ maxParticipants ≤ 128
 *  - preset's minimum players ≤ maxParticipants (Standard ≥ 3, Deep ≥ 7)
 *  - registrationDeadline > Date.now()/1000
 *
 * Also pre-fetches `ProtocolConfig` to surface a clean `ProtocolNotInitializedError`
 * when the singleton hasn't been initialized yet.
 */
export async function createTournament(
  client: BracketChainClient,
  config: CreateTournamentConfig,
): Promise<CreateTournamentResult> {
  const signer = assertSigner(client, "createTournament");
  const organizer = signer.address;

  // ── client-side validation ────────────────────────────────────────────────
  const nameBytes = new TextEncoder().encode(config.name).length;
  if (nameBytes === 0 || nameBytes > MAX_TOURNAMENT_NAME_BYTES) {
    throw new NameTooLongError();
  }

  if (!Number.isInteger(config.maxParticipants)) {
    throw new BracketChainSDKError(
      "maxParticipants must be an integer",
      "InvalidArgument",
    );
  }
  if (config.maxParticipants < MIN_PARTICIPANTS)
    throw new MinParticipantsNotMetError();
  if (config.maxParticipants > MAX_PARTICIPANTS)
    throw new MaxParticipantsExceededError();

  const presetMin = PRESET_MIN_PARTICIPANTS[config.payoutPreset];
  if (presetMin === undefined) {
    throw new BracketChainSDKError(
      `Unknown payout preset variant: ${String(config.payoutPreset)}`,
      "InvalidArgument",
    );
  }
  if (presetMin > config.maxParticipants) {
    throw new InvalidPayoutPresetError();
  }

  const entryFee = toBigInt(config.entryFee, "entryFee");
  const registrationDeadline = toBigInt(
    config.registrationDeadline,
    "registrationDeadline",
  );
  const organizerDeposit = toBigInt(
    config.organizerDeposit ?? 0n,
    "organizerDeposit",
  );
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (registrationDeadline <= nowSec) {
    throw new RegistrationClosedError();
  }

  // ── account derivation ────────────────────────────────────────────────────
  const [protocolConfigPda] = await findProtocolConfigPda();
  const [tournamentPda] = await findTournamentPda({
    organizer,
    name: config.name,
  });
  const [vaultPda] = await findVaultPda({ tournament: tournamentPda });

  // Pre-flight: parallel fetch of ProtocolConfig (must exist) + tournament PDA
  // (must NOT exist).
  let protocolConfigAccount;
  let existingTournament;
  try {
    [protocolConfigAccount, existingTournament] = await Promise.all([
      fetchMaybeProtocolConfig(client.rpc, protocolConfigPda),
      fetchMaybeTournament(client.rpc, tournamentPda),
    ]);
  } catch (err) {
    throw mapError(err);
  }

  if (existingTournament.exists) {
    throw new TournamentNameTakenError();
  }
  if (!protocolConfigAccount.exists) {
    throw new ProtocolNotInitializedError();
  }

  const tokenMint = config.tokenMint ?? protocolConfigAccount.data.defaultMint;

  // ── organizer ATA: derive + create idempotently when deposit > 0 ──────────
  const preInstructions = [];
  let organizerTokenAccount: Address | undefined;

  if (organizerDeposit > 0n) {
    const [organizerAta] = await findAssociatedTokenPda({
      owner: organizer,
      mint: tokenMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    organizerTokenAccount = organizerAta;
    preInstructions.push(
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: signer,
        owner: organizer,
        mint: tokenMint,
        ata: organizerAta,
      }),
    );
  }

  const createIx = await getCreateTournamentInstructionAsync({
    organizer: signer,
    protocolConfig: protocolConfigPda,
    tokenMint,
    tournament: tournamentPda,
    vault: vaultPda,
    organizerTokenAccount,
    name: config.name,
    entryFee,
    maxParticipants: config.maxParticipants,
    payoutPreset: config.payoutPreset,
    registrationDeadline,
    organizerDeposit,
  });

  try {
    const txSignature = await sendInstructions(client, signer, [
      ...preInstructions,
      createIx,
    ]);
    return { tournamentPda, vaultPda, txSignature };
  } catch (err) {
    // TOCTOU: a competing tx with the same [organizer, name] PDA landed
    // between our preflight and our send.
    if (isAccountAlreadyInitialized(err)) {
      throw new TournamentNameTakenError(err);
    }
    throw err instanceof Error ? mapError(err) : err;
  }
}

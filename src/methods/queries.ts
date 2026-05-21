import {
  getAddressEncoder,
  getBase58Decoder,
  type Address,
  type Base58EncodedBytes,
  type ReadonlyUint8Array,
} from "@solana/kit";

import type { BracketChainClient } from "../client";
import { mapError } from "../errors";
import {
  fetchMatchNode,
  fetchParticipant,
  fetchProtocolConfig,
  fetchTournament,
  getMatchNodeDecoder,
  getParticipantDecoder,
  getTournamentDecoder,
  MATCH_NODE_DISCRIMINATOR,
  PARTICIPANT_DISCRIMINATOR,
  TOURNAMENT_DISCRIMINATOR,
  type MatchNode,
  type Participant,
  type ProtocolConfig,
  type Tournament,
} from "../generated";
import type {
  MatchNodeWithAddress,
  ParticipantWithAddress,
  TournamentState,
  TournamentWithAddress,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Single-account fetches.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a single Tournament PDA's deserialized state.
 *
 * Use {@link getTournamentState} when the caller also needs the bracket and
 * participant list — it parallelizes those reads.
 *
 * @throws UnknownProgramError if the PDA does not exist or is owned by a
 *   different program.
 */
export async function getTournament(
  client: BracketChainClient,
  pda: Address,
): Promise<Tournament> {
  try {
    const account = await fetchTournament(client.rpc, pda);
    return account.data;
  } catch (err) {
    throw mapError(err);
  }
}

/**
 * Fetch a single MatchNode PDA's deserialized state.
 */
export async function getMatch(
  client: BracketChainClient,
  pda: Address,
): Promise<MatchNode> {
  try {
    const account = await fetchMatchNode(client.rpc, pda);
    return account.data;
  } catch (err) {
    throw mapError(err);
  }
}

/**
 * Fetch a single Participant PDA's deserialized state.
 */
export async function getParticipant(
  client: BracketChainClient,
  pda: Address,
): Promise<Participant> {
  try {
    const account = await fetchParticipant(client.rpc, pda);
    return account.data;
  } catch (err) {
    throw mapError(err);
  }
}

/**
 * Fetch the singleton ProtocolConfig PDA (treasury, default mint, fee bps).
 *
 * @throws UnknownProgramError if the protocol has not been initialized yet.
 */
export async function getProtocolConfig(
  client: BracketChainClient,
  pda: Address,
): Promise<ProtocolConfig> {
  try {
    const account = await fetchProtocolConfig(client.rpc, pda);
    return account.data;
  } catch (err) {
    throw mapError(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// List queries (getProgramAccounts).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List every Tournament PDA owned by the program.
 *
 * Backed by `getProgramAccounts` — fine on devnet, but in production prefer
 * `BracketChainIndexerClient` which paginates and filters by status. Treat
 * this as a dev/fallback tool.
 */
export async function listTournaments(
  client: BracketChainClient,
): Promise<TournamentWithAddress[]> {
  const rows = await fetchProgramAccountsByDiscriminator(
    client,
    TOURNAMENT_DISCRIMINATOR,
  );
  const decoder = getTournamentDecoder();
  return rows.map((row) => ({
    address: row.address,
    account: decoder.decode(row.data),
  }));
}

/**
 * All MatchNode accounts belonging to a tournament, sorted by `(round, matchIndex)`.
 *
 * Filtered server-side via a two-filter memcmp:
 *   1. discriminator at offset 0
 *   2. tournament pubkey at offset 8 (first field after the discriminator)
 */
export async function getAllMatches(
  client: BracketChainClient,
  tournamentPda: Address,
): Promise<MatchNodeWithAddress[]> {
  const rows = await fetchProgramAccountsByDiscriminator(
    client,
    MATCH_NODE_DISCRIMINATOR,
    { tournamentFilter: tournamentPda, tournamentOffset: 8n },
  );
  const decoder = getMatchNodeDecoder();
  return rows
    .map((row) => ({ address: row.address, account: decoder.decode(row.data) }))
    .sort((a, b) => {
      if (a.account.round !== b.account.round) {
        return a.account.round - b.account.round;
      }
      return a.account.matchIndex - b.account.matchIndex;
    });
}

/**
 * All Participant accounts for a tournament, sorted by `seedIndex`.
 */
export async function listParticipants(
  client: BracketChainClient,
  tournamentPda: Address,
): Promise<ParticipantWithAddress[]> {
  const rows = await fetchProgramAccountsByDiscriminator(
    client,
    PARTICIPANT_DISCRIMINATOR,
    { tournamentFilter: tournamentPda, tournamentOffset: 8n },
  );
  const decoder = getParticipantDecoder();
  return rows
    .map((row) => ({ address: row.address, account: decoder.decode(row.data) }))
    .sort((a, b) => a.account.seedIndex - b.account.seedIndex);
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite — runs three queries in parallel and bundles the result.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Composite read for the tournament-detail view: fetches the Tournament PDA,
 * its bracket (all MatchNodes), and its participant list in parallel.
 */
export async function getTournamentState(
  client: BracketChainClient,
  tournamentPda: Address,
): Promise<TournamentState> {
  const [tournament, bracket, participants] = await Promise.all([
    getTournament(client, tournamentPda),
    getAllMatches(client, tournamentPda),
    listParticipants(client, tournamentPda),
  ]);
  return {
    address: tournamentPda,
    tournament,
    bracket,
    participants,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ProgramAccountsFilterOptions {
  tournamentFilter?: Address;
  tournamentOffset?: bigint;
}

interface RawProgramAccount {
  address: Address;
  data: ReadonlyUint8Array;
}

function toBase58Bytes(data: ReadonlyUint8Array): Base58EncodedBytes {
  return getBase58Decoder().decode(data) as Base58EncodedBytes;
}

async function fetchProgramAccountsByDiscriminator(
  client: BracketChainClient,
  discriminator: ReadonlyUint8Array,
  opts: ProgramAccountsFilterOptions = {},
): Promise<RawProgramAccount[]> {
  const filters: Array<
    | { memcmp: { bytes: Base58EncodedBytes; encoding: "base58"; offset: bigint } }
  > = [
    {
      memcmp: {
        bytes: toBase58Bytes(discriminator),
        encoding: "base58",
        offset: 0n,
      },
    },
  ];

  if (opts.tournamentFilter !== undefined) {
    filters.push({
      memcmp: {
        bytes: toBase58Bytes(
          getAddressEncoder().encode(opts.tournamentFilter),
        ),
        encoding: "base58",
        offset: opts.tournamentOffset ?? 8n,
      },
    });
  }

  try {
    const rows = await client.rpc
      .getProgramAccounts(client.programAddress, {
        encoding: "base64",
        commitment: client.commitment,
        filters,
      })
      .send();

    return rows.map((row) => {
      const [base64Str] = row.account.data;
      // Node + browsers: `atob` decodes base64 → binary string; convert to bytes.
      const binary = atob(base64Str);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return { address: row.pubkey, data: bytes };
    });
  } catch (err) {
    throw mapError(err);
  }
}

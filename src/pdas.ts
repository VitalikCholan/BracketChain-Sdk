import {
  getAddressEncoder,
  getBytesEncoder,
  getProgramDerivedAddress,
  type Address,
  type ProgramDerivedAddress,
} from "@solana/kit";

import { BRACKET_CHAIN_PROGRAM_ADDRESS } from "./generated";

// Codama-generated PDAs cover everything Anchor declared in instruction
// accounts. We re-export them under the original SDK names so the public API
// stays stable across the Anchor→Kit migration.
export {
  findParticipantPda,
  findProtocolConfigPda,
  findTournamentPda,
  findVaultPda,
} from "./generated";

const MATCH_SEED = new Uint8Array([109, 97, 116, 99, 104]); // "match"

export interface MatchSeeds {
  tournament: Address;
  /** 0-indexed bracket round; must fit in a u8. */
  round: number;
  /** 0-indexed match position within the round; must fit in a u16. */
  matchIndex: number;
}

/**
 * MatchNode PDA: ["match", tournament, [round: u8], match_index_le_bytes(u16)].
 *
 * Match accounts are passed as `remaining_accounts` to `start_tournament`, so
 * Codama doesn't auto-generate a finder for them — this is the hand-written
 * Kit equivalent.
 */
export async function findMatchPda(
  seeds: MatchSeeds,
  config: { programAddress?: Address } = {},
): Promise<ProgramDerivedAddress> {
  if (!Number.isInteger(seeds.round) || seeds.round < 0 || seeds.round > 255) {
    throw new RangeError(`round must fit in u8 (0..255), got ${seeds.round}`);
  }
  if (
    !Number.isInteger(seeds.matchIndex) ||
    seeds.matchIndex < 0 ||
    seeds.matchIndex > 0xffff
  ) {
    throw new RangeError(
      `matchIndex must fit in u16 (0..65535), got ${seeds.matchIndex}`,
    );
  }
  const matchIndexLe = new Uint8Array(2);
  matchIndexLe[0] = seeds.matchIndex & 0xff;
  matchIndexLe[1] = (seeds.matchIndex >> 8) & 0xff;

  return await getProgramDerivedAddress({
    programAddress: config.programAddress ?? BRACKET_CHAIN_PROGRAM_ADDRESS,
    seeds: [
      getBytesEncoder().encode(MATCH_SEED),
      getAddressEncoder().encode(seeds.tournament),
      new Uint8Array([seeds.round]),
      matchIndexLe,
    ],
  });
}

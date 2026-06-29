import { test, mock, before } from "node:test";
import assert from "node:assert/strict";

import * as generated from "../generated";
import * as queries from "./queries";

// 8 distinct, valid base58 pubkeys to stand in for player wallets / blockhash.
const PUBKEYS = [
  "So11111111111111111111111111111111111111112",
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
];
const ORGANIZER = "BPFLoaderUpgradeab1e11111111111111111111111";
const TOURNAMENT = "Vote111111111111111111111111111111111111111";

// Mutable per-test scenario the (single) module mocks read live, so we only
// evaluate the SUT once despite the ESM import cache.
let scenario: { tournament: Record<string, unknown>; participants: number } = {
  tournament: {},
  participants: 8,
};

function fakeClient() {
  return {
    signer: { address: ORGANIZER },
    commitment: "confirmed",
    rpc: {
      getLatestBlockhash: () => ({
        send: async () => ({
          value: { blockhash: PUBKEYS[0], lastValidBlockHeight: 1000n },
        }),
      }),
    },
  } as never;
}

function tournament(overrides: Record<string, unknown>) {
  return {
    organizer: ORGANIZER,
    status: generated.TournamentStatus.Registration,
    participantCount: 8,
    settlementMode: generated.SettlementMode.OrganizerOnly,
    seedRevealed: false,
    seedHash: new Uint8Array(32),
    matchesInitialized: 0,
    ...overrides,
  };
}

before(() => {
  mock.module("../generated", {
    namedExports: {
      ...generated,
      fetchTournament: async () => ({
        data: scenario.tournament,
        address: TOURNAMENT,
      }),
    },
  });
  mock.module("./queries", {
    namedExports: {
      ...queries,
      listParticipants: async () =>
        PUBKEYS.slice(0, scenario.participants).map((wallet) => ({
          account: { wallet },
        })),
    },
  });
});

test("buildStartTournamentTransactions: OrganizerOnly 8 players → 1 chunk tx", async () => {
  scenario = { tournament: tournament({}), participants: 8 };
  const { buildStartTournamentTransactions } = await import("./startTournament");

  const built = await buildStartTournamentTransactions(fakeClient(), {
    tournamentPda: TOURNAMENT as never,
  });

  // bracketSize 8 → 7 matches → chunkSize 7 → 1 transaction.
  assert.equal(built.transactions.length, 1);
  assert.equal(built.bracketSize, 8);
  assert.equal(built.totalMatches, 7);
  assert.ok(built.transactions[0]!.messageBytes.length > 0);
});

test("buildStartTournamentTransactions: Oracle without revealed seed throws", async () => {
  scenario = {
    tournament: tournament({
      settlementMode: generated.SettlementMode.Oracle,
      seedRevealed: false,
    }),
    participants: 8,
  };
  const { buildStartTournamentTransactions } = await import("./startTournament");

  await assert.rejects(
    () =>
      buildStartTournamentTransactions(fakeClient(), {
        tournamentPda: TOURNAMENT as never,
      }),
    /seed/i,
  );
});

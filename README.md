# `@bracketchain/sdk`

TypeScript SDK for the [BracketChain](https://github.com/VitalikCholan/BracketChain-Main) on-chain tournament protocol on Solana — PDA-escrowed prize vaults with automatic preset-based payout distribution, three settlement modes (organizer / player-reported / oracle), and verifiable VRF bracket seeding.

```bash
pnpm add @bracketchain/sdk
```

---

## Status

| Field | Value |
|---|---|
| Version | [![npm](https://img.shields.io/npm/v/@bracketchain/sdk)](https://www.npmjs.com/package/@bracketchain/sdk) — `0.6.0-dev` |
| License | MIT |
| Build | tsup, CJS + ESM dual, types included |
| Client base | [`@solana/kit`](https://www.npmjs.com/package/@solana/kit) 6.9 — no `@coral-xyz/anchor`, no `@solana/web3.js` v1 in the runtime |
| Generated tree | [Codama](https://github.com/codama-idl/codama) — accounts, instructions, decoders, PDA finders |
| Devnet program | `3YpkUKBh8288XN2dCKSwBnEdyc5UozSJ19A1ZCLpUZsZ` |
| Subpaths | none yet — `./react` hooks subpath is V1 (reference hooks live in [`BracketChain-Frontend/hooks/`](../BracketChain-Frontend/hooks)) |

---

## What's in the box

Two orthogonal client classes — they share zero state and can be used independently:

- **`BracketChainClient`** wraps a Kit `Rpc` (+ optional `RpcSubscriptions`) for chain reads, transaction construction, and account-change subscriptions. Mutating methods require a `signer`; query methods do not.
- **`BracketChainIndexerClient`** is a typed `fetch` wrapper for the indexer's REST API — fast listings, cached reads, AbortSignal-aware. Zero on-chain deps.

Plus: 28 mutation + read methods spanning the full tournament lifecycle and all three settlement modes (including the arbitrator-signed `settleFinal` for multi-placement finals), 27 typed error subclasses with a `mapError` helper, 5 PDA helpers, seven numeric enums, and account-subscription via `subscribe()`.

### Settlement modes

A tournament's `settlementMode` is locked at create-time and decides who finalizes match results:

| Mode | Who reports | Methods |
|---|---|---|
| `OrganizerOnly` (default, MVP) | The organizer | `reportResult` |
| `PlayerReported` (Stage B) | Players propose → counterparty confirms/disputes → permissionless claim → organizer arbitrates disputes | `proposeResult`, `confirmResult`, `disputeResult`, `claimResult`, `resolveDispute`, `forceClaimDisputed`, `settleFinal` |
| `Oracle` (Stage C / V1.2) | A Switchboard On-Demand feed proposes; the same propose/dispute/claim envelope finalizes | `commitMatchLobby`, `bindMatchFeed`, `proposeResultOracle` (+ the dispute methods above) |

`PlayerReported` and `Oracle` tournaments also expect verifiable bracket seeding via `requestSeed` (organizer, pre-start) + `revealSeed` (permissionless cron), and may be torn down with `cancelTournament` / `partialRefundChunk` / `closeTournament`.

---

## Quick start

### Read-only — listing tournaments via the indexer

For pages that don't need a wallet (e.g. `/explore`, public tournament view).

```ts
import { BracketChainIndexerClient } from "@bracketchain/sdk";

const indexer = new BracketChainIndexerClient({
  baseUrl: "https://bracketchain-indexer-production.up.railway.app",
});

const tournaments = await indexer.listTournaments({
  status: "Registration",
  limit: 20,
});
// tournaments: IndexerTournament[]  (BigInt fields are decimal strings)
```

### Read-only — single tournament from chain (no signer)

```ts
import { address } from "@solana/kit";
import { BracketChainClient, getTournamentState } from "@bracketchain/sdk";

const client = new BracketChainClient({
  rpc: "https://api.devnet.solana.com",
  // signer omitted — read-only
});

const pda = address("...");
const state = await getTournamentState(client, pda);
// state.tournament, state.bracket, state.participants
```

Mutating methods throw if called without a `signer` — `client.canSign === false`.

### Writing — create a tournament

```ts
import { address } from "@solana/kit";
import {
  BracketChainClient,
  createTournament,
  PayoutPreset,
  SettlementMode,
  SupportedGame,
} from "@bracketchain/sdk";

const client = new BracketChainClient({
  rpc: "https://api.devnet.solana.com",
  rpcSubscriptions: "wss://api.devnet.solana.com",
  signer,                                 // TransactionSigner — see "Signer setup" below
  commitment: "confirmed",
});

const result = await createTournament(client, {
  name: "Friday Night CS2",               // ≤ 32 bytes (UTF-8)
  entryFee: 1_000_000n,                   // 1 USDC (6 decimals) — bigint or number
  maxParticipants: 16,
  payoutPreset: { __kind: "Standard" },   // data-enum: { __kind: "WinnerTakesAll" | "Standard" | "Deep" }
                                          // or arbitrary: { __kind: "Custom", fields: [[5000,3000,2000,0,0,0,0,0]] }
  registrationDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  organizerDeposit: 0n,                   // optional top-up to prize pool (refundable)
  // V1.1 options (all optional, with safe defaults):
  game: SupportedGame.Manual,             // default Manual; Phase 1 accepts Manual | Dota2
  settlementMode: SettlementMode.OrganizerOnly, // default OrganizerOnly
  disputeWindowSecs: 3600,                // default 1h; ignored by OrganizerOnly
});

console.log(result.tournamentPda);        // already a base58 Address string
console.log(result.vaultPda);
console.log(result.txSignature);
```

`organizerDeposit > 0n` auto-creates the organizer's ATA if missing and folds the transfer into the same transaction. The deposit is refundable (returned on cancel and on the final-match payout) and is excluded from the prize-pool basis.

### Joining and reporting (organizer-reported)

```ts
import { joinTournament, reportResult } from "@bracketchain/sdk";

await joinTournament(client, { tournamentPda });

await reportResult(client, {
  tournamentPda,
  round: 0,
  matchIndex: 0,
  winner: winnerAddress,                  // Address — must equal playerA or playerB
  // On the final match, pass `placements` to drive prize distribution:
  // WTA (1): [champion]
  // Standard (3): [champion, runnerUp, third]
  // Deep (7): [champion, runnerUp, third, 5–8 × 4]
});
// On the final match, reportResult also distributes prizes + takes the protocol
// fee (feeBps on ProtocolConfig — 3.5% on devnet) in the same tx.
```

### Player-reported settlement (`PlayerReported` mode)

```ts
import {
  proposeResult,
  confirmResult,
  disputeResult,
  claimResult,
  resolveDispute,
} from "@bracketchain/sdk";

// 1. A player proposes the winner, opening the dispute window.
await proposeResult(client, { tournamentPda, round: 0, matchIndex: 0, proposedWinner });

// 2a. The counterparty confirms → finalizes immediately.
await confirmResult(client, { tournamentPda, round: 0, matchIndex: 0 /*, placements on final */ });

// 2b. …or disputes → routes to the organizer, re-arms the deadline to +24h.
await disputeResult(client, { tournamentPda, round: 0, matchIndex: 0, disputeReason: 1 });

// 3. If neither happens before claim_deadline, anyone may finalize (auto-claim cron).
await claimResult(client, { tournamentPda, round: 0, matchIndex: 0 });

// 4. The organizer (arbitrator) settles a disputed match.
await resolveDispute(client, { tournamentPda, round: 0, matchIndex: 0, winner });
```

`forceClaimDisputed` is the permissionless escape hatch: it finalizes a *disputed* match for the proposed winner once the 24h force-claim window elapses and the organizer has stayed silent. The final-match calls (`confirmResult` / `claimResult` / `resolveDispute` / `forceClaimDisputed`) accept the same `placements` array as `reportResult` and distribute prizes the same way.

**Multi-placement finals settle via the arbitrator (H-1).** Permissionless and counterparty paths may only finalize `WinnerTakesAll` finals — on `Standard` / `Deep` / `Custom` finals the program rejects them with `UntrustedMultiPlacementFinal`. The routing cheat-sheet:

- WTA final → permissionless `claimResult`
- Multi-placement final, **undisputed** past the window → arbitrator-signed `settleFinal` (winner stays pinned to the proposal; the arbitrator only adjudicates placements 3..N)
- **Disputed** final (any preset) → `resolveDispute`

### Verifiable seeding (VRF)

`PlayerReported` / `Oracle` tournaments require a revealed seed before `startTournament`:

```ts
import { requestSeed, revealSeed } from "@bracketchain/sdk";

// Organizer binds a committed Switchboard randomness account (create + commit it
// client-side first with the Switchboard SDK).
await requestSeed(client, { tournamentPda, randomnessAccount });

// Permissionless (vrf-reveal cron): bundle Switchboard's own reveal ix ahead of
// reveal_seed in the SAME tx — the value is only readable in its reveal slot.
await revealSeed(client, { tournamentPda, randomnessAccount, preInstructions: [switchboardRevealIx] });
```

### Oracle settlement (`Oracle` mode, V1.2)

```ts
import {
  commitMatchLobby,
  bindMatchFeed,
  proposeResultOracle,
  setOracleConfig,
} from "@bracketchain/sdk";

// Admin: configure the Switchboard queue + staleness bounds once on ProtocolConfig.
await setOracleConfig(client, { switchboardQueue, maxStaleSlots: 150, minOracleSamples: 1 });

// Organizer: commit the match to a game lobby, then bind its Switchboard feed.
await commitMatchLobby(client, {
  tournamentPda, round: 0, matchIndex: 0,
  playerA, playerB, lobbyId, expectedFeedHash,
});
await bindMatchFeed(client, { tournamentPda, round: 0, matchIndex: 0, switchboardFeed });

// Permissionless relayer: write the feed-reported winner into the proposal envelope.
await proposeResultOracle(client, { tournamentPda, round: 0, matchIndex: 0, switchboardFeed });
// Finalize via confirmResult / claimResult / disputeResult — the same envelope.
```

### Live updates — `subscribe()`

```ts
import { subscribe } from "@bracketchain/sdk";

const unsubscribe = subscribe(client, tournamentPda, (event) => {
  if (event.kind === "tournament") {
    // Tournament account changed — status flip, new participant, etc.
    console.log("Tournament:", event.account.status);
  } else {
    // Match account changed — proposal recorded, winner reported, etc.
    console.log("Match:", event.account.matchIndex, "→", event.account.status);
  }
}, {
  matchPdas: [match0, match1],            // optional — subscribe to specific matches too
  onError: ({ kind, address, cause }) => {
    // Decode failures + WS errors surface here. No auto-reconnect in MVP — V1 will add Drift v2-style resub.
    console.warn("Subscription error:", kind, address, cause);
  },
});

// Later (sync — no need to await):
unsubscribe();
```

`subscribe()` requires `rpcSubscriptions` on the client; reads and writes do not.

### Signer setup

The client expects a Kit `TransactionSigner`. Two common sources:

```ts
// Node script — from a Solana keypair file
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { readFile } from "node:fs/promises";

const bytes = JSON.parse(await readFile("~/.config/solana/id.json", "utf8"));
const signer = await createKeyPairSignerFromBytes(new Uint8Array(bytes));
```

```ts
// Frontend — wrap a wallet-adapter `AnchorWallet` into a TransactionSigner.
// See BracketChain-Frontend/lib/sdk.ts for the production bridge (uses
// `@solana/compat.fromLegacyPublicKey` + a `VersionedTransaction` round-trip).
```

---

## Public surface

Everything below is re-exported from `@bracketchain/sdk`. Anything not listed is internal and may change without a major bump. (The generated `migrateProtocolConfig` / `migrateV1Tournament` / `setSasConfig` / `initializeProtocol` instructions are used by the deploy + migration scripts, not the public method surface.)

### Clients

| Export | Purpose |
|---|---|
| `BracketChainClient` | Kit-backed wrapper — `rpc`, `rpcSubscriptions?`, `signer?`, `programAddress`, `canSign` |
| `BracketChainIndexerClient` | REST wrapper for the indexer service |

### Reads (chain — `BracketChainClient`)

| Method | Returns |
|---|---|
| `getTournament(client, pda)` | `Tournament` |
| `getMatch(client, pda)` | `MatchNode` |
| `getParticipant(client, pda)` | `Participant` |
| `getProtocolConfig(client, pda)` | `ProtocolConfig` |
| `listTournaments(client)` | `TournamentWithAddress[]` (uses `getProgramAccounts`; prefer `BracketChainIndexerClient.listTournaments` for paginated UI listings) |
| `getAllMatches(client, tournamentPda)` | `MatchNodeWithAddress[]` (sorted by `round`, `matchIndex`) |
| `listParticipants(client, tournamentPda)` | `ParticipantWithAddress[]` (sorted by `seedIndex`) |
| `getTournamentState(client, pda)` | `TournamentState` — composite read of tournament + bracket + participants |

### Reads (REST — `BracketChainIndexerClient`)

| Method | Endpoint |
|---|---|
| `listTournaments(opts)` | `GET /tournaments?status=&limit=` |
| `getTournament(addr)` | `GET /tournaments/:address` |
| `getPayouts(addr, opts)` | `GET /tournaments/:address/payouts` |
| `getParticipants(addr, opts)` | `GET /tournaments/:address/participants` |
| `getMatches(addr, opts)` | `GET /tournaments/:address/matches` |

All methods accept an `AbortSignal` for cancellation. BigInt fields arrive as decimal strings.

### Mutations — lifecycle

| Method | Wraps |
|---|---|
| `createTournament(client, config)` | `create_tournament` (+ optional organizer-deposit ATA setup + CPI). Returns `{ tournamentPda, vaultPda, txSignature }` |
| `joinTournament(client, params)` | `join_tournament` |
| `startTournament(client, params)` | `start_tournament` (chunked — 7 matches per chunk; SDK handles the chunk loop, bracket descriptor build, byes, and per-tx compute-budget overrides) |
| `cancelTournament(client, params)` | `cancel_tournament` (pre-start; organizer flips status to Cancelled, then any signer drives idempotent refund chunks + organizer-deposit return) |
| `partialCancelTournament(client, params)` | `partial_cancel_tournament` (organizer-only, mid-`Active`; flips status to `PartialCancelled` and freezes the bracket — refunds then run via `partialRefundChunk`) |
| `partialRefundChunk(client, params)` | `partial_refund_chunk` (permissionless, idempotent full-refund chunks for a `PartialCancelled` tournament — Policy A) |
| `closeTournament(client, params)` | `close_tournament` (permissionless rent reclaim for a terminal tournament — closes child PDAs in chunks, then optionally vault + Tournament PDA) |

### Mutations — organizer-reported settlement

| Method | Wraps |
|---|---|
| `reportResult(client, params)` | `report_result` (final match auto-distributes prize + fee) |

### Mutations — player-reported settlement (Stage B)

| Method | Wraps |
|---|---|
| `proposeResult(client, params)` | `propose_result` — a player proposes a winner, opening the dispute window |
| `confirmResult(client, params)` | `confirm_result` — counterparty accepts; finalizes the match |
| `disputeResult(client, params)` | `dispute_result` — counterparty disputes; routes to organizer, re-arms deadline +24h |
| `claimResult(client, params)` | `claim_result` — permissionless finalize of an undisputed proposal past its deadline |
| `resolveDispute(client, params)` | `resolve_dispute` — organizer/arbitrator settles a disputed match |
| `settleFinal(client, params)` | `settle_final` — arbitrator-signed settlement of an undisputed multi-placement (non-WTA) final; adjudicates placements 3..N |
| `forceClaimDisputed(client, params)` | `force_claim_disputed` — permissionless finalize of a disputed match after the 24h organizer-silence backstop |

### Mutations — VRF seeding (Stage B)

| Method | Wraps |
|---|---|
| `requestSeed(client, params)` | `request_seed` — organizer binds a committed Switchboard randomness account |
| `revealSeed(client, params)` | `reveal_seed` — permissionless; reads the revealed value and sets `seed_hash` (bundle Switchboard's reveal ix via `preInstructions`) |

### Mutations — oracle settlement (Stage C / V1.2)

| Method | Wraps |
|---|---|
| `setOracleConfig(client, params)` | `set_oracle_config` — admin sets the Switchboard queue + staleness bounds on ProtocolConfig |
| `commitMatchLobby(client, params)` | `commit_match_lobby` — organizer commits a match to a game lobby + expected feed hash |
| `bindMatchFeed(client, params)` | `bind_match_feed` — organizer binds a Switchboard PullFeed to a committed match |
| `proposeResultOracle(client, params)` | `propose_result_oracle` — permissionless relayer writes the feed-reported winner (`source = Oracle`) |

Every mutation returns at least a `txSignature`; the finalize methods (`reportResult`, `confirmResult`, `claimResult`, `resolveDispute`, `forceClaimDisputed`, `settleFinal`) also return `isFinal`. The chunked methods (`startTournament`, `cancelTournament`, `partialRefundChunk`, `closeTournament`) return a `txSignatures[]` array.

### PDA helpers — all `async`, return `ProgramDerivedAddress` (`[Address, number]`)

```ts
import {
  findProtocolConfigPda,    // [b"protocol_config"]
  findTournamentPda,        // [b"tournament", organizer, name]
  findVaultPda,             // [b"vault", tournament]
  findParticipantPda,       // [b"participant", tournament, player]
  findMatchPda,             // [b"match", tournament, [bracket: u8], [round: u8], match_index_le_bytes(u16)]
} from "@bracketchain/sdk";

const [tournamentPda] = await findTournamentPda({ organizer, name: "My Tournament" });
const [matchPda] = await findMatchPda({ tournament: tournamentPda, round: 0, matchIndex: 0 });
```

`findMatchPda` takes an optional `bracket` lane (C9 schema-prep) — it defaults to `0` for single-elimination (V1) and is included in the PDA seed ahead of future double-elim/group formats. `programAddress` defaults to `BRACKET_CHAIN_PROGRAM_ADDRESS` but is overridable via a second arg: `findTournamentPda(seeds, { programAddress })`.

### Account & value types

`Tournament`, `Participant`, `MatchNode`, `ProtocolConfig`, the value types `MatchInitDescriptor` + `PlacementPayout`, plus `*WithAddress` variants that bundle the decoded account with its `Address`. All come from the Codama-generated tree and use Kit's `Address` branded string + `bigint` for u64 fields.

`Tournament` now carries the V1 settlement fields: `settlementMode`, `game`, `disputeWindowSecs`, `arbitrator`, the VRF fields (`vrfRandomnessAccount`, `vrfCommitSlot`, `seedRevealed`), and the organizer-deposit fields (`organizerDeposit`, `organizerDepositRefunded`). `MatchNode` carries the proposal envelope (`proposalSource`, `proposer`, `proposedWinner`, `proposedAt`, `claimDeadline`, `disputed`, `disputeReason`) and the oracle commitment (`commitment`, `switchboardFeed`). `ProtocolConfig` adds `authority`, `sasCredential`, `sasSchemas`, `switchboardQueue`, `maxStaleSlots`, `minOracleSamples` alongside `treasury`, `defaultMint`, `feeBps`.

### Enums (numeric — compare with `===`)

```ts
import {
  TournamentStatus,   // Registration | PendingBracketInit | Active | Completed | Cancelled | PartialCancelled
  MatchStatus,        // Pending | Active | Completed
  PayoutPreset,       // data-enum: { __kind: "WinnerTakesAll" | "Standard" | "Deep" | "Custom" }
  SettlementMode,     // 0 OrganizerOnly | 1 PlayerReported | 2 Oracle
  SupportedGame,      // 0 Manual | 1 Dota2 | 2 Cs2Faceit | 3 Valorant | 4 LoL
  ProposalSource,     // 0 None | 1 Player | 2 Oracle | 3 GameServer
} from "@bracketchain/sdk";

if (tournament.status === TournamentStatus.Active) { /* ... */ }
const payoutPreset = { __kind: "Standard" } as const;   // or { __kind: "Custom", fields: [[...8 bps...]] }
```

Codama emits plain numeric enums — no Anchor-style `{ active: {} }` tagged objects, no `getEnumKind` helper.

### Errors

```ts
import {
  BracketChainSDKError,            // base class
  InsufficientFundsError,          // SOL balance too low
  InsufficientBalanceError,        // SPL token balance too low
  RegistrationClosedError,
  TournamentNameTakenError,
  NameTooLongError,                // > 32 bytes
  TournamentFullError,
  InvalidPayoutPresetError,
  InvalidTokenMintError,
  ProtocolNotInitializedError,
  AlreadyRegisteredError,
  UnauthorizedReporterError,
  InvalidMatchError,
  MatchAlreadyReportedError,
  TournamentNotActiveError,
  NonParticipantWinnerError,
  TournamentInProgressError,
  MaxParticipantsExceededError,
  MinParticipantsNotMetError,
  TransactionFailedError,
  UnknownProgramError,
  mapError,
} from "@bracketchain/sdk";
```

`mapError(err)` takes a raw `SolanaError` / wallet / transport error and returns the most specific `BracketChainSDKError` subclass it can identify. It walks the `SolanaError` `cause` chain so wrapped errors still get classified correctly, decoding the on-chain Anchor error number (offset 6000) where present. Recommended pattern in callers:

```ts
try {
  await createTournament(client, config);
} catch (err) {
  const sdkErr = err instanceof BracketChainSDKError ? err : mapError(err);

  if (sdkErr instanceof RegistrationClosedError) { /* show specific copy */ }
  else if (sdkErr instanceof NameTooLongError)   { /* show specific copy */ }
  // ... etc
  else                                            { console.error(sdkErr); }
}
```

`instanceof` survives minification — `constructor.name` would not, so prefer the typed branches over name-string checks.

---

## Architecture notes

### Two orthogonal clients, deliberately

A read-only viewer page (`/t/[id]`) instantiates a `BracketChainIndexerClient` for fast paginated reads and a signer-less `BracketChainClient` purely as an RPC fallback for the `getTournament` chain read when the indexer is stale. Neither needs the other's state. A writing page (`/create`) instantiates a `BracketChainClient` with a `signer`. The write path never touches the indexer client.

This keeps the SDK composable across all four BracketChain frontend route types (read-only public, write-with-wallet, organizer dashboard, explore listing) without forcing a single "god client" on consumers.

### The settlement envelope is source-agnostic

Player-reported and oracle results share one on-chain envelope on `MatchNode` (`proposalSource`, `proposedWinner`, `claimDeadline`, `disputed`). Whether a result came from a player or a Switchboard feed, the same `confirmResult` / `claimResult` / `disputeResult` / `resolveDispute` / `forceClaimDisputed` methods finalize it — the oracle is "just another proposer". The `_finalize.ts` helper backs every finalize path (advance the winner for non-final matches, distribute the pool + fee for the final).

### `subscribe()` is MVP-pattern

A single `rpcSubscriptions.accountNotifications` subscription per PDA (Tournament + optional MatchNodes), discriminated `kind: "tournament" | "match"` events, and an `onError` callback for decode failures and connection-level errors. No auto-reconnect on WebSocket drop — that's V1 (Drift v2 pattern). The frontend's `useTournamentView` hook layers a 30s inactivity safety net and a fast reconcile-on-`onError` to compensate.

### Codama-generated tree, not vendored IDL

The on-chain client tree (accounts, instructions, decoders, declared PDA finders) lives under `src/generated/` and is produced from the program's Anchor IDL by [Codama](https://github.com/codama-idl/codama). It is **committed to the repo**, not generated at install time, so consumers can `pnpm add @bracketchain/sdk` without an IDL pipeline. To regenerate after a program redeploy, re-run Codama against the new IDL (the recipe lives in the program repo) and commit the diff.

A handful of methods (`closeTournament`, `partialCancelTournament`, `partialRefundChunk`) hand-build their instruction with the discriminator + account layout. As of the Stage F codama regen the generated builders for these now exist in `src/generated/`; the method wrappers will migrate onto them in a follow-up (the hand-built layout is verified against the same IDL, so behaviour is identical).

### Anchor → Kit migration (0.3.x → 0.4.0)

Breaking changes from the original Anchor SDK:

| Before (0.3.x) | After (0.4.0+) |
|---|---|
| `new BracketChainClient({ connection, wallet })` | `new BracketChainClient({ rpc, rpcSubscriptions?, signer? })` |
| `PublicKey` everywhere | `Address` (Kit branded string) |
| `new BN(x)` for u64 | `bigint` (e.g. `1_000_000n`) or `number` |
| `{ active: {} }` enum tag objects | Numeric enum: `TournamentStatus.Active` |
| `payoutPreset("standard")` helper | `{ __kind: "Standard" }` (Codama data-enum; `Custom` carries `fields: [[u16; 8]]`) |
| `getEnumKind(tournament.status)` | `tournament.status === TournamentStatus.Active` |
| `result.tournamentPda.toBase58()` | `result.tournamentPda` (already a base58 string) |
| PDA helpers sync, return `[PublicKey, number]` | All `async`, return `ProgramDerivedAddress` (`[Address, number]`) |
| `BN` re-export | removed — use native `bigint` |

The frontend bridge in [`BracketChain-Frontend/lib/sdk.ts`](../BracketChain-Frontend/lib/sdk.ts) shows one way to wire a wallet-adapter `AnchorWallet` into a Kit `TransactionSigner`.

### What's new since 0.4.0

The 0.4 → 0.6 line is additive (no breaking client-construction changes), behind a single program redeploy at `3YpkUKBh8288XN2dCKSwBnEdyc5UozSJ19A1ZCLpUZsZ`:

- **`SettlementMode`** — `PlayerReported` + `Oracle` settlement flows alongside the original `OrganizerOnly`.
- **`SupportedGame`** — per-tournament game tag gating the SAS identity requirement at join (Phase 1: `Manual` + `Dota2`).
- **VRF seeding** — `requestSeed` / `revealSeed` make bracket seeding verifiable for non-organizer modes.
- **Lifecycle teardown** — `closeTournament` (permissionless rent reclaim) and `partialRefundChunk` (Policy-A full refunds for partial cancellation).
- **`createTournament`** gained optional `game`, `settlementMode`, `disputeWindowSecs` and now returns `vaultPda`.
- **`findMatchPda`** gained the `bracket` lane seed (defaults to `0`).

---

## Build & develop

```bash
pnpm install
pnpm build           # tsup → dist/index.{js,mjs,d.ts}
pnpm dev             # watch mode
pnpm typecheck       # tsc --noEmit (no emit; check types only)
```

`prepublishOnly` runs `pnpm build` so a publish always ships fresh `dist/` artifacts. The `files` field in `package.json` whitelists only `dist/` for the npm tarball — source isn't shipped.

### Scripts (`scripts/`)

| Script | Purpose |
|---|---|
| `init-protocol.ts` | Idempotent one-shot to initialize the singleton `ProtocolConfig` on a target cluster. Invoked by the program repo's `make deploy-devnet` after `anchor deploy`. |
| `e2e-demo.ts` | End-to-end demo path that exercises create → join × N → start → report → distribute (and a cancel + refund flow) against a live cluster. Useful as a script-level smoke test alongside the program's mocha suite. See [`scripts/README.md`](./scripts/README.md). |

---

## Repository layout

```
.
├── package.json              # version, exports, deps
├── tsup.config.ts            # CJS + ESM dual build, dts
├── tsconfig.json
├── src/
│   ├── index.ts              # the only public entry
│   ├── client.ts             # BracketChainClient (Kit)
│   ├── api.ts                # BracketChainIndexerClient + Indexer* types
│   ├── errors.ts             # 27 typed error subclasses + mapError
│   ├── pdas.ts               # findMatchPda + re-exports of generated finders
│   ├── types.ts              # WithAddress + composite read shapes, re-exports from generated/
│   ├── generated/            # Codama output — accounts, instructions, decoders, PDA finders
│   └── methods/
│       ├── createTournament.ts joinTournament.ts startTournament.ts
│       ├── reportResult.ts                       # organizer-reported settlement
│       ├── proposeResult.ts confirmResult.ts disputeResult.ts
│       ├── claimResult.ts resolveDispute.ts forceClaimDisputed.ts
│       ├── requestSeed.ts revealSeed.ts          # VRF seeding
│       ├── commitMatchLobby.ts bindMatchFeed.ts proposeResultOracle.ts setOracleConfig.ts
│       ├── cancelTournament.ts partialRefundChunk.ts closeTournament.ts
│       ├── subscribe.ts
│       ├── queries.ts        # getTournament, getMatch, getParticipant, getProtocolConfig, listTournaments, getAllMatches, listParticipants, getTournamentState
│       ├── _finalize.ts       # internal: shared advance/distribute machinery
│       └── _send.ts          # internal: assertSigner + sendInstructions
├── scripts/
│   ├── init-protocol.ts
│   ├── e2e-demo.ts
│   └── README.md
└── dist/                     # build output — published to npm; gitignored locally
```

---

## Related repositories

| Repo | Purpose |
|---|---|
| [`bracketchain-main`](../bracketchain-main) | Top-level README, hackathon plan, MVP-vs-V1 deltas, demo script |
| [`bracket-chain-programs`](../bracket-chain-programs) | The Anchor program — source IDL for Codama generation |
| [`bracket-chain-indexer`](../bracket-chain-indexer) | NestJS read API + Helius webhook ingestor — REST surface consumed by `BracketChainIndexerClient` |
| [`BracketChain-Frontend`](../BracketChain-Frontend) | Next.js web app — primary consumer of this SDK |

---

## License

MIT. See [`LICENSE`](./LICENSE).

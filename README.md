# `@bracketchain/sdk`

TypeScript SDK for the [BracketChain](https://github.com/VitalikCholan/BracketChain-Main) on-chain tournament protocol on Solana — PDA-escrowed prize vaults with automatic preset-based payout distribution.

```bash
pnpm add @bracketchain/sdk
```

---

## Status

| Field | Value |
|---|---|
| Version | [![npm](https://img.shields.io/npm/v/@bracketchain/sdk)](https://www.npmjs.com/package/@bracketchain/sdk) — `0.4.0` |
| License | MIT |
| Build | tsup, CJS + ESM dual, types included |
| Client base | [`@solana/kit`](https://www.npmjs.com/package/@solana/kit) 6.9 — no `@coral-xyz/anchor`, no `@solana/web3.js` v1 in the runtime |
| Generated tree | [Codama](https://github.com/codama-idl/codama) — accounts, instructions, decoders, PDA finders |
| Devnet program | `AuXJKpuZtkegs2ZSgopgckhN7Ev8bUz4zBc238LD2F1` |
| Subpaths | none yet — `./react` hooks subpath is V1 (reference hooks live in [`BracketChain-Frontend/hooks/`](https://github.com/btcthirst/BracketChain-Frontend/tree/main/hooks)) |

---

## Contents

- [What's in the box](#whats-in-the-box) — two clients, 21 errors, 5 PDA helpers
- [Quick start](#quick-start) — read-only, single-from-chain, write, subscribe
- [Public surface](#public-surface) — every export, in tables
- [Architecture notes](#architecture-notes) — orthogonal clients, MVP `subscribe`, IDL vendoring
- [Build & develop](#build--develop)
- [Repository layout](#repository-layout)
- [Related repositories](#related-repositories)
- [License](#license)

---

## What's in the box

Two orthogonal client classes — they share zero state and can be used independently:

- **`BracketChainClient`** wraps a Kit `Rpc` (+ optional `RpcSubscriptions`) for chain reads, transaction construction, and account-change subscriptions. Mutating methods require a `signer`; query methods do not.
- **`BracketChainIndexerClient`** is a typed `fetch` wrapper for the indexer's REST API — fast listings, cached reads, AbortSignal-aware. Zero on-chain deps.

Plus: 21 typed error classes with a `mapError` helper, 5 PDA helpers, numeric enums (`TournamentStatus`, `MatchStatus`, `PayoutPreset`), and account-subscription via `subscribe()`.

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
import { BracketChainClient, createTournament, PayoutPreset } from "@bracketchain/sdk";

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
  payoutPreset: PayoutPreset.Standard,    // numeric enum: WinnerTakesAll | Standard | Deep
  registrationDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  organizerDeposit: 0n,                   // optional top-up to prize pool
});

console.log(result.tournamentPda);        // already a base58 Address string
console.log(result.txSignature);
```

`organizerDeposit > 0n` auto-creates the organizer's ATA if missing and folds the transfer into the same transaction.

### Joining and reporting

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
// On the final match, reportResult also distributes prizes + takes the 3.5% protocol fee in the same tx.
```

### Live updates — `subscribe()`

```ts
import { subscribe } from "@bracketchain/sdk";

const unsubscribe = subscribe(client, tournamentPda, (event) => {
  if (event.kind === "tournament") {
    // Tournament account changed — status flip, new participant, etc.
    console.log("Tournament:", event.account.status);
  } else {
    // Match account changed — winner reported, etc.
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

Everything below is re-exported from `@bracketchain/sdk`. Anything not listed is internal and may change without a major bump.

### Clients

| Export | Purpose |
|---|---|
| `BracketChainClient` | Kit-backed wrapper — `rpc`, `rpcSubscriptions?`, `signer?`, `programAddress`, `canSign` |
| `BracketChainIndexerClient` | REST wrapper for the indexer service |

### Reads (chain — `BracketChainClient`)

| Method | Returns |
|---|---|
| `getTournament(client, pda)` | `Tournament \| null` |
| `getMatch(client, pda)` | `MatchNode \| null` |
| `getParticipant(client, pda)` | `Participant \| null` |
| `getProtocolConfig(client)` | `ProtocolConfig \| null` |
| `listTournaments(client)` | `TournamentWithAddress[]` (uses `getProgramAccounts`; prefer `BracketChainIndexerClient.listTournaments` for paginated UI listings) |
| `getAllMatches(client, tournamentPda)` | `MatchNodeWithAddress[]` |
| `listParticipants(client, tournamentPda)` | `ParticipantWithAddress[]` |
| `getTournamentState(client, pda)` | `TournamentState` — composite read of the four above |

### Reads (REST — `BracketChainIndexerClient`)

| Method | Endpoint |
|---|---|
| `listTournaments(opts)` | `GET /tournaments?status=&limit=` |
| `getTournament(addr)` | `GET /tournaments/:address` |
| `getPayouts(addr, opts)` | `GET /tournaments/:address/payouts` |
| `getParticipants(addr, opts)` | `GET /tournaments/:address/participants` |
| `getMatches(addr, opts)` | `GET /tournaments/:address/matches` |

All methods accept an `AbortSignal` for cancellation.

### Mutations

| Method | Wraps |
|---|---|
| `createTournament(client, config)` | `create_tournament` instruction (+ optional organizer-deposit ATA setup + CPI) |
| `joinTournament(client, params)` | `join_tournament` instruction |
| `startTournament(client, params)` | `start_tournament` instruction (chunked — 7 matches per chunk; SDK handles the chunk loop and per-tx compute-budget overrides) |
| `reportResult(client, params)` | `report_result` instruction (final match auto-distributes prize + fee) |
| `cancelTournament(client, params)` | `cancel_tournament` instruction (organizer flips status; subsequent calls drive refund chunks — any signer) |

### PDA helpers — all `async`, return `ProgramDerivedAddress` (`[Address, number]`)

```ts
import {
  findProtocolConfigPda,    // [b"protocol_config"]
  findTournamentPda,        // [b"tournament", organizer, name]
  findVaultPda,             // [b"vault", tournament]
  findParticipantPda,       // [b"participant", tournament, wallet]
  findMatchPda,             // [b"match", tournament, [round: u8], match_index_le_bytes(u16)]
} from "@bracketchain/sdk";

const [tournamentPda] = await findTournamentPda({ organizer, name: "My Tournament" });
```

`programAddress` defaults to `BRACKET_CHAIN_PROGRAM_ADDRESS` but is overridable via a second arg: `findTournamentPda(seeds, { programAddress })`.

### Account types

`Tournament`, `Participant`, `MatchNode`, `ProtocolConfig`, plus `*WithAddress` variants that bundle the decoded account with its `Address`. All come from the Codama-generated tree and use Kit's `Address` branded string + `bigint` for u64 fields.

### Enums (numeric — compare with `===`)

```ts
import { TournamentStatus, MatchStatus, PayoutPreset } from "@bracketchain/sdk";

if (tournament.status === TournamentStatus.Active) {
  // ...
}

const payoutPreset = PayoutPreset.Standard;
// 0 → WinnerTakesAll, 1 → Standard, 2 → Deep
```

No more Anchor-style `{ active: {} }` tagged objects and no `getEnumKind` helper — Codama emits plain numeric enums.

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

`mapError(err)` takes a raw `SolanaError` / wallet / transport error and returns the most specific `BracketChainSDKError` subclass it can identify. It walks the `SolanaError` `cause` chain so wrapped errors still get classified correctly. Recommended pattern in callers:

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

### `subscribe()` is MVP-pattern

A single `rpcSubscriptions.accountNotifications` subscription per PDA (Tournament + optional MatchNodes), discriminated `kind: "tournament" | "match"` events, and an `onError` callback for decode failures and connection-level errors. No auto-reconnect on WebSocket drop — that's V1 (Drift v2 pattern). The frontend's `useTournamentView` hook layers a 30s inactivity safety net and a fast reconcile-on-`onError` to compensate.

### Codama-generated tree, not vendored IDL

The on-chain client tree (accounts, instructions, decoders, declared PDA finders) lives under `src/generated/` and is produced from the program's Anchor IDL by [Codama](https://github.com/codama-idl/codama). It is **committed to the repo**, not generated at install time, so consumers can `pnpm add @bracketchain/sdk` without an IDL pipeline. To regenerate after a program redeploy, re-run Codama against the new IDL (the recipe lives in the program repo) and commit the diff.

The pre-0.4 vendored `bracket_chain.json` IDL + the `sync-idl` script are gone — Codama replaced them.

### Anchor → Kit migration (0.3.x → 0.4.0)

Breaking changes consumers care about:

| Before (0.3.x) | After (0.4.0) |
|---|---|
| `new BracketChainClient({ connection, wallet })` | `new BracketChainClient({ rpc, rpcSubscriptions?, signer? })` |
| `PublicKey` everywhere | `Address` (Kit branded string) |
| `new BN(x)` for u64 | `bigint` (e.g. `1_000_000n`) or `number` |
| `{ active: {} }` enum tag objects | Numeric enum: `TournamentStatus.Active` |
| `payoutPreset("standard")` helper | `PayoutPreset.Standard` (numeric enum value) |
| `getEnumKind(tournament.status)` | `tournament.status === TournamentStatus.Active` |
| `result.tournamentPda.toBase58()` | `result.tournamentPda` (already a base58 string) |
| PDA helpers sync, return `[PublicKey, number]` | All `async`, return `ProgramDerivedAddress` (`[Address, number]`) |
| `BN` re-export | removed — use native `bigint` |

The frontend bridge in [`BracketChain-Frontend/lib/sdk.ts`](../BracketChain-Frontend/lib/sdk.ts) shows one way to wire a wallet-adapter `AnchorWallet` into a Kit `TransactionSigner` via `@solana/compat`'s `fromLegacyPublicKey` + a `VersionedTransaction` round-trip for signing.

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
| `e2e-demo.ts` | End-to-end demo path that exercises create → join × N → start → report → distribute against a live cluster. Useful as a script-level smoke test alongside the program's mocha suite. See [`scripts/README.md`](./scripts/README.md). |

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
│   ├── errors.ts             # 21 error classes + mapError
│   ├── pdas.ts               # MatchPda helper + re-exports of generated finders
│   ├── types.ts              # WithAddress + composite read shapes, re-exports from generated/
│   ├── generated/            # Codama output — accounts, instructions, decoders, PDA finders
│   └── methods/
│       ├── createTournament.ts
│       ├── joinTournament.ts
│       ├── startTournament.ts
│       ├── reportResult.ts
│       ├── cancelTournament.ts
│       ├── subscribe.ts
│       ├── queries.ts        # getTournament, getMatch, getParticipant, getProtocolConfig, listTournaments, getAllMatches, listParticipants, getTournamentState
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

MIT. See [`LICENSE`](https://github.com/VitalikCholan/BracketChain-Sdk/blob/main/LICENSE).

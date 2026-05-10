# `@bracketchain/sdk`

TypeScript SDK for the [BracketChain](https://github.com/VitalikCholan/BracketChain-Main) on-chain tournament protocol on Solana — PDA-escrowed prize vaults with automatic preset-based payout distribution.

```bash
pnpm add @bracketchain/sdk
```

---

## Status

| Field | Value |
|---|---|
| Version | [![npm](https://img.shields.io/npm/v/@bracketchain/sdk)](https://www.npmjs.com/package/@bracketchain/sdk) — `0.3.0` |
| License | MIT |
| Build | tsup, CJS + ESM dual, types included |
| Anchor | 0.32.1 (pinned, matches on-chain program build) |
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

- **`BracketChainClient`** wraps Anchor for chain reads, transaction construction, and WebSocket subscriptions. Mutating methods require a connected wallet; query methods do not.
- **`BracketChainIndexerClient`** is a typed `fetch` wrapper for the indexer's REST API — fast listings, cached reads, AbortSignal-aware. No Anchor dependency.

Plus: 21 typed error classes with a `mapError` helper, 5 PDA helpers, runtime `BN` re-export, and account-subscription via `subscribe()`.

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

### Read-only — single tournament from chain (no wallet)

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { BracketChainClient, getTournamentState } from "@bracketchain/sdk";

const client = new BracketChainClient({
  connection: new Connection("https://api.devnet.solana.com", "confirmed"),
  // wallet omitted — read-only
});

const pda = new PublicKey("...");
const state = await getTournamentState(client, pda);
// state.tournament, state.matches, state.participants
```

Mutating methods will throw if called without a wallet — `client.canSign === false`.

### Writing — create a tournament

```ts
import { BracketChainClient, createTournament, payoutPreset, BN } from "@bracketchain/sdk";

const client = new BracketChainClient({
  connection,
  wallet: anchorWallet,                  // from @solana/wallet-adapter-react useAnchorWallet()
  commitment: "confirmed",
});

const result = await createTournament(client, {
  name: "Friday Night CS2",              // ≤ 32 bytes (UTF-8)
  entryFee: new BN(1_000_000),           // 1 USDC (6 decimals)
  maxParticipants: 16,
  payoutPreset: payoutPreset("standard"),  // "winnerTakesAll" | "standard" | "deep"
  registrationDeadline: Math.floor(Date.now() / 1000) + 3600,  // unix seconds
  organizerDeposit: new BN(0),           // optional top-up to prize pool
});

console.log(result.tournamentPda.toBase58());
console.log(result.txSignature);
```

`organizerDeposit > 0` auto-creates the organizer's ATA if missing and folds the transfer into the same transaction.

### Joining and reporting

```ts
import { joinTournament, reportResult } from "@bracketchain/sdk";

await joinTournament(client, { tournamentPda });

await reportResult(client, {
  tournamentPda,
  round: 0,
  matchIndex: 0,
  winner: winnerPubkey,
  scoreA: 16,
  scoreB: 14,
});
// On the final match, reportResult also distributes prizes + takes the 3.5% protocol fee in the same tx.
```

### Live updates — `subscribe()`

```ts
import { subscribe } from "@bracketchain/sdk";

const unsubscribe = subscribe(client, tournamentPda, (event) => {
  if (event.kind === "tournament") {
    // Tournament account changed — status flip, new participant, etc.
    console.log("Tournament:", event.tournament.status);
  } else {
    // Match account changed — winner reported, etc.
    console.log("Match:", event.match.matchIndex, "→", event.match.status);
  }
}, {
  matchPdas: [match0, match1],          // optional — subscribe to specific matches too
  onError: (err) => {
    // Decode failures + WS errors surface here. No auto-reconnect in MVP — V1 will add Drift v2-style resub.
    console.warn("Subscription error:", err);
  },
});

// Later:
await unsubscribe();
```

---

## Public surface

Everything below is re-exported from `@bracketchain/sdk`. Anything not listed is internal and may change without a major bump.

### Clients

| Export | Purpose |
|---|---|
| `BracketChainClient` | Anchor wrapper — `connection`, `provider`, `program`, `programId`, `canSign` |
| `BracketChainIndexerClient` | REST wrapper for the indexer service |

### Reads (Anchor — `BracketChainClient`)

| Method | Returns |
|---|---|
| `getTournament(client, pda)` | `Tournament \| null` |
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

### PDA helpers

```ts
import {
  findProtocolConfigPda,    // [b"protocol_config"]
  findTournamentPda,        // [b"tournament", organizer, name]
  findVaultPda,             // [b"vault", tournament]
  findParticipantPda,       // [b"participant", tournament, wallet]
  findMatchPda,             // [b"match", tournament, [round: u8], match_index_le_bytes(u16)]
} from "@bracketchain/sdk";
```

Each returns `[PublicKey, number]` (PDA + bump). `programId` defaults to the canonical devnet program but is overridable.

### Account types

`Tournament`, `Participant`, `MatchNode`, `ProtocolConfig`, plus `*WithAddress` variants that bundle the deserialized account with its public key.

### Enum helpers

Anchor enums are tagged-variant objects (`{ active: {} }`). Two helpers translate between that shape and ergonomic string kinds:

```ts
import { getEnumKind, payoutPreset } from "@bracketchain/sdk";

const kind = getEnumKind(tournament.status);
// kind: "registration" | "pendingBracketInit" | "active" | "completed" | "cancelled"

const variant = payoutPreset("standard");
// variant: { standard: {} }   — the shape Anchor expects in createTournament args
```

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

`mapError(err)` takes a raw Anchor / wallet / transport error and returns the most specific `BracketChainSDKError` subclass it can identify. Recommended pattern in callers:

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

### `BN` re-export

```ts
import { BN } from "@bracketchain/sdk";
new BN(1_000_000);
```

Re-exported from `bn.js` so consumers don't need a direct dependency on `bn.js` or `@coral-xyz/anchor` just to construct `u64` arguments.

---

## Architecture notes

### Two orthogonal clients, deliberately

A read-only viewer page (`/t/[id]`) instantiates a `BracketChainIndexerClient` for fast paginated reads and a wallet-less `BracketChainClient` purely as an RPC fallback for the `getTournament` chain read when the indexer is stale. Neither needs the other's state. A writing page (`/create`) instantiates a `BracketChainClient` with a connected wallet. The write path never touches the indexer client.

This keeps the SDK composable across all four BracketChain frontend route types (read-only public, write-with-wallet, organizer dashboard, explore listing) without forcing a single "god client" on consumers.

### `subscribe()` is MVP-pattern

A single `connection.onAccountChange` subscription per PDA (Tournament + optional MatchNodes), discriminated `kind: "tournament" | "match"` events, and an `onError` callback for decode failures. No auto-reconnect on WebSocket drop — that's V1 (Drift v2 pattern). The frontend's `useTournamentView` hook layers a 30s inactivity safety net and a fast reconcile-on-`onError` to compensate.

### IDL is vendored, sync is manual

The Anchor IDL lives at `src/idl/bracket_chain.json` (+ `bracket_chain.ts` for typed Anchor accessors). It's vendored, not generated at install time. After every program build, run `pnpm sync-idl` from the SDK repo (or `make build` in the program repo, which invokes `make sync-idl` automatically and copies into both the SDK and the indexer).

If you forget, the BorshCoder will silently decode new event payloads against the old discriminator and struct layout, producing junk values that don't crash. Codama-generated client is the V1 fix — see the open-architecture items in the main repo.

---

## Build & develop

```bash
pnpm install
pnpm build           # tsup → dist/index.{js,mjs,d.ts}
pnpm dev             # watch mode
pnpm typecheck       # tsc --noEmit (no emit; check types only)
pnpm sync-idl        # copy IDL + types from ../bracket-chain-programs/target
```

`prepublishOnly` runs `pnpm build` so a publish always ships fresh `dist/` artifacts. The `files` field in `package.json` whitelists only `dist/` for the npm tarball — source isn't shipped.

### Scripts (`scripts/`)

| Script | Purpose |
|---|---|
| `init-protocol.ts` | Idempotent one-shot to initialize the singleton `ProtocolConfig` on a target cluster. Invoked by the program repo's `make deploy-devnet` after `anchor deploy`. |
| `e2e-demo.ts` | End-to-end demo path that exercises create → join × N → start → report → distribute against a live cluster. Useful as a script-level smoke test alongside the program's mocha suite. |
| `sync-idl.mjs` | Copies IDL + types from the program build target into `src/idl/`. Manual step; run after every Anchor build. |

---

## Repository layout

```
.
├── package.json             # version, exports, deps
├── tsup.config.ts           # CJS + ESM dual build, dts
├── tsconfig.json
├── src/
│   ├── index.ts             # the only public entry
│   ├── client.ts            # BracketChainClient
│   ├── api.ts               # BracketChainIndexerClient + Indexer* types
│   ├── errors.ts            # 21 error classes + mapError
│   ├── pdas.ts              # 5 PDA helpers
│   ├── types.ts             # account shapes, enums, helpers
│   ├── idl/
│   │   ├── bracket_chain.json    # vendored from program build
│   │   └── bracket_chain.ts      # Anchor-typed wrapper
│   └── methods/
│       ├── createTournament.ts
│       ├── joinTournament.ts
│       ├── startTournament.ts
│       ├── reportResult.ts
│       ├── cancelTournament.ts
│       ├── subscribe.ts
│       └── queries.ts        # getTournament, getProtocolConfig, listTournaments, getAllMatches, listParticipants, getTournamentState
├── scripts/
│   ├── init-protocol.ts
│   ├── e2e-demo.ts
│   ├── sync-idl.mjs
│   └── README.md
└── dist/                    # build output — published to npm; gitignored locally
```

---

## Related repositories

| Repo | Purpose |
|---|---|
| [`BracketChain-Main`](https://github.com/VitalikCholan/BracketChain-Main) | Top-level README, hackathon plan, MVP-vs-V1 deltas, demo script |
| [`BracketChain-Programs`](https://github.com/VitalikCholan/BracketChain-Programs) | The Anchor program — source of the vendored IDL |
| [`BracketChain-Indexer`](https://github.com/VitalikCholan/BracketChain-Indexer) | NestJS read API + Helius webhook ingestor — REST surface consumed by `BracketChainIndexerClient` |
| [`BracketChain-Frontend`](https://github.com/btcthirst/BracketChain-Frontend) | Next.js web app — primary consumer of this SDK |

---

## License

MIT. See [`LICENSE`](https://github.com/VitalikCholan/BracketChain-Sdk/blob/main/LICENSE).

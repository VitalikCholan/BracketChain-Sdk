/**
 * One-shot Switchboard oracle bootstrap for the BracketChain protocol singleton.
 *
 * Calls `set_oracle_config(switchboard_queue, max_stale_slots, min_oracle_samples)`
 * so that Oracle-mode settlement works: `bind_match_feed` validates that a bound
 * PullFeed belongs to this queue, and `propose_result_oracle` enforces the
 * staleness / sample-count thresholds when reading it. While these fields are
 * still zeroed (the post-`initialize_protocol` default), every `bind_match_feed`
 * reverts with `WrongFeedAccount` — the whole Oracle mode (and the VRF-gated
 * start flow it shares plumbing with) is blocked. This is the third and final
 * bootstrap step after `init-protocol.ts` and `set-sas-config.ts`.
 *
 * Defaults: the canonical Switchboard On-Demand devnet queue + conservative
 * thresholds within the program's L-2 bounds (`min_oracle_samples >= 1`,
 * `max_stale_slots <= 9_000`). Phase 1.5 (real Steam/OpenDota feeds) is
 * expected to re-run this with `--min-oracle-samples=2`.
 *
 * Idempotent: if the on-chain config already matches the requested values, the
 * script prints them and exits 0 without sending a transaction. Re-running with
 * different values overwrites (the ix allows updates by the protocol authority).
 *
 * Usage:
 *   tsx scripts/set-oracle-config.ts --check                # read-only: print on-chain config + authority
 *   tsx scripts/set-oracle-config.ts
 *   tsx scripts/set-oracle-config.ts --rpc=https://devnet.helius-rpc.com/?api-key=KEY
 *   tsx scripts/set-oracle-config.ts --queue=<pubkey> --max-stale-slots=750 --min-oracle-samples=1
 *   FUNDER_KEYPAIR=/path/id.json tsx scripts/set-oracle-config.ts
 *
 * The funder keypair MUST be the protocol authority (the wallet that ran
 * `initialize_protocol`); the program rejects anyone else with
 * `UnauthorizedAuthority`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
} from "@solana/kit";

import {
  BRACKET_CHAIN_PROGRAM_ADDRESS,
  fetchMaybeProtocolConfig,
  findProtocolConfigPda,
  getSetOracleConfigInstructionAsync,
} from "../src/generated";

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

// Canonical Switchboard On-Demand DEVNET queue (docs.switchboard.xyz →
// Solana Accounts). NOT the On-Demand program id — the queue is the account
// every bound PullFeed must reference.
const DEFAULT_DEVNET_QUEUE = address(
  "EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7",
);

// ~5 minutes at devnet's ~2.5 slots/s. Generous for a match-result feed that
// updates once per match, while staying far inside the program's L-2 ceiling
// of 9_000 slots (~1 hour).
const DEFAULT_MAX_STALE_SLOTS = 750;

// Phase 1 ships against single-job sample feeds; Phase 1.5 (real Steam +
// OpenDota cross-check jobs) re-runs this with 2. Program floor is 1 (L-2).
const DEFAULT_MIN_ORACLE_SAMPLES = 1;

const MIN_FUNDER_LAMPORTS = 1_000_000n; // 0.001 SOL — tx fee only, no rent

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

interface Cli {
  rpc: string;
  funderKeypair: string;
  queue: Address;
  maxStaleSlots: number;
  minOracleSamples: number;
  checkOnly: boolean;
}

function parseCli(): Cli {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const getInt = (name: string, fallback: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0)
      throw new Error(`--${name} must be a non-negative integer, got "${raw}"`);
    return n;
  };

  const queueArg = get("queue");

  return {
    rpc: get("rpc") ?? "https://api.devnet.solana.com",
    funderKeypair:
      get("funder") ??
      process.env.FUNDER_KEYPAIR ??
      path.join(os.homedir(), ".config", "solana", "id.json"),
    queue: queueArg ? address(queueArg) : DEFAULT_DEVNET_QUEUE,
    maxStaleSlots: getInt("max-stale-slots", DEFAULT_MAX_STALE_SLOTS),
    minOracleSamples: getInt("min-oracle-samples", DEFAULT_MIN_ORACLE_SAMPLES),
    checkOnly: args.includes("--check"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function loadSigner(filePath: string) {
  const expanded = filePath.startsWith("~")
    ? path.join(os.homedir(), filePath.slice(1))
    : filePath;
  const raw = JSON.parse(fs.readFileSync(expanded, "utf8")) as number[];
  return createKeyPairSignerFromBytes(Uint8Array.from(raw));
}

function shortAddr(addr: Address): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function deriveWsEndpoint(httpEndpoint: string): string {
  // Mirrors lib/sdk.ts logic in the frontend — only flips the protocol prefix.
  if (httpEndpoint.startsWith("https://"))
    return `wss://${httpEndpoint.slice("https://".length)}`;
  if (httpEndpoint.startsWith("http://"))
    return `ws://${httpEndpoint.slice("http://".length)}`;
  return httpEndpoint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli = parseCli();
  const rpc = createSolanaRpc(cli.rpc);

  console.log(
    cli.checkOnly
      ? "BracketChain oracle config check (read-only)"
      : "BracketChain oracle config bootstrap",
  );
  console.log(`  rpc:                ${cli.rpc}`);
  console.log(`  switchboard_queue:  ${cli.queue}  (desired)`);
  console.log(`  max_stale_slots:    ${cli.maxStaleSlots}  (desired)`);
  console.log(`  min_oracle_samples: ${cli.minOracleSamples}  (desired)`);

  // ── Fetch existing config ──────────────────────────────────────────────────
  const [protocolConfigPda] = await findProtocolConfigPda();
  console.log(`  program_id:         ${BRACKET_CHAIN_PROGRAM_ADDRESS}`);
  console.log(`  config_pda:         ${protocolConfigPda}`);

  const existing = await fetchMaybeProtocolConfig(rpc, protocolConfigPda);
  if (!existing.exists) {
    throw new Error(
      `ProtocolConfig does not exist on this cluster. Run \`tsx scripts/init-protocol.ts --rpc=${cli.rpc}\` first.`,
    );
  }

  const cfg = existing.data;
  console.log(`\n  on-chain authority:          ${cfg.authority}`);
  console.log(`  on-chain switchboard_queue:  ${cfg.switchboardQueue}`);
  console.log(`  on-chain max_stale_slots:    ${cfg.maxStaleSlots}`);
  console.log(`  on-chain min_oracle_samples: ${cfg.minOracleSamples}`);

  const alreadyMatches =
    cfg.switchboardQueue === cli.queue &&
    cfg.maxStaleSlots === cli.maxStaleSlots &&
    cfg.minOracleSamples === cli.minOracleSamples;

  if (cli.checkOnly) {
    console.log(
      alreadyMatches
        ? "\n✅ Oracle config matches the desired values — Oracle mode is unblocked."
        : `\n⚠️  Oracle config does NOT match. The protocol authority (${shortAddr(cfg.authority)}) must run this script without --check.`,
    );
    return;
  }

  const rpcSubscriptions = createSolanaRpcSubscriptions(
    deriveWsEndpoint(cli.rpc),
  );
  const funder = await loadSigner(cli.funderKeypair);
  console.log(`  funder:             ${funder.address}`);

  // ── Sanity: funder has SOL ─────────────────────────────────────────────────
  const { value: balance } = await rpc.getBalance(funder.address).send();
  if (balance < MIN_FUNDER_LAMPORTS) {
    throw new Error(
      `Funder ${shortAddr(funder.address)} has ${Number(balance) / 1e9} SOL — need ≥ ${Number(MIN_FUNDER_LAMPORTS) / 1e9}. Run \`solana airdrop 1 --url devnet\`.`,
    );
  }

  if (cfg.authority !== funder.address) {
    throw new Error(
      `Funder ${shortAddr(funder.address)} is NOT the protocol authority (${shortAddr(cfg.authority)}). ` +
        `Pass the authority keypair via FUNDER_KEYPAIR or --funder=<path>.`,
    );
  }

  if (alreadyMatches) {
    console.log("\n✅ Oracle config already matches — nothing to do.");
    return;
  }

  // ── Send set_oracle_config ─────────────────────────────────────────────────
  console.log("\n  sending set_oracle_config...");
  const ix = await getSetOracleConfigInstructionAsync({
    authority: funder,
    protocolConfig: protocolConfigPda,
    switchboardQueue: cli.queue,
    maxStaleSlots: cli.maxStaleSlots,
    minOracleSamples: cli.minOracleSamples,
  });

  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(funder, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions([ix], m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });
  await sendAndConfirm(signed, { commitment: "confirmed" });
  const sig = getSignatureFromTransaction(signed);

  console.log(`\n✅ Oracle config written.`);
  console.log(`   tx:         ${sig}`);
  console.log(
    `   explorer:   https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  );

  // ── Verify ─────────────────────────────────────────────────────────────────
  const verified = await fetchMaybeProtocolConfig(rpc, protocolConfigPda);
  if (verified.exists) {
    console.log(`   switchboard_queue:  ${verified.data.switchboardQueue}`);
    console.log(`   max_stale_slots:    ${verified.data.maxStaleSlots}`);
    console.log(`   min_oracle_samples: ${verified.data.minOracleSamples}`);
  }
}

main().catch((err) => {
  console.error("\n❌ Oracle config bootstrap failed:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

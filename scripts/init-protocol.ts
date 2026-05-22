/**
 * One-shot initializer for the BracketChain protocol singleton on a live cluster.
 *
 * Calls `initialize_protocol(treasury, usdc_mint)` ONCE, with the canonical devnet
 * USDC mint by default — so any wallet that already holds devnet USDC can join
 * tournaments without first receiving a fresh test mint.
 *
 * Use this instead of `e2e-demo.ts --flow=happy` when you only want to bootstrap
 * the protocol (no demo tournament). Idempotent: if `protocol_config` already
 * exists, the script prints its contents and exits with code 0.
 *
 * Usage:
 *   tsx scripts/init-protocol.ts
 *   tsx scripts/init-protocol.ts --rpc=https://devnet.helius-rpc.com/?api-key=KEY
 *   tsx scripts/init-protocol.ts --treasury=<pubkey>
 *   tsx scripts/init-protocol.ts --usdc-mint=<pubkey>     # override default
 *   FUNDER_KEYPAIR=/path/id.json tsx scripts/init-protocol.ts
 *
 * The funder keypair is the protocol authority. They must have ≥ ~0.005 SOL on
 * the target cluster (rent for the ProtocolConfig PDA + tx fee).
 *
 * Devnet program ID (BRACKET_CHAIN_PROGRAM_ADDRESS): AuXJKpuZtkegs2ZSgopgckhN7Ev8bUz4zBc238LD2F1.
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
import { fetchMaybeMint } from "@solana-program/token";

import {
  BRACKET_CHAIN_PROGRAM_ADDRESS,
  fetchMaybeProtocolConfig,
  findProtocolConfigPda,
  getInitializeProtocolInstructionAsync,
} from "../src/generated";

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

// Canonical devnet USDC. Any wallet on devnet that ever ran the test faucet at
// https://spl-token-faucet.com/?token-name=USDC-Dev or received a transfer of
// "devnet USDC" holds tokens of this mint.
const DEFAULT_USDC_MINT = address(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

const MIN_FUNDER_LAMPORTS = 5_000_000n; // 0.005 SOL

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

interface Cli {
  rpc: string;
  funderKeypair: string;
  usdcMint: Address;
  treasury: Address | null; // null → use funder pubkey
}

function parseCli(): Cli {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };

  const usdcMintArg = get("usdc-mint");
  const treasuryArg = get("treasury");

  return {
    rpc: get("rpc") ?? "https://api.devnet.solana.com",
    funderKeypair:
      get("funder") ??
      process.env.FUNDER_KEYPAIR ??
      path.join(os.homedir(), ".config", "solana", "id.json"),
    usdcMint: usdcMintArg ? address(usdcMintArg) : DEFAULT_USDC_MINT,
    treasury: treasuryArg ? address(treasuryArg) : null,
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
  const rpcSubscriptions = createSolanaRpcSubscriptions(
    deriveWsEndpoint(cli.rpc),
  );
  const funder = await loadSigner(cli.funderKeypair);
  const treasury = cli.treasury ?? funder.address;

  console.log("BracketChain protocol initializer");
  console.log(`  rpc:           ${cli.rpc}`);
  console.log(`  funder:        ${funder.address}`);
  console.log(
    `  treasury:      ${treasury}${cli.treasury ? "" : "  (defaulted to funder)"}`,
  );
  console.log(
    `  usdc_mint:     ${cli.usdcMint}${cli.usdcMint === DEFAULT_USDC_MINT ? "  (canonical devnet USDC)" : "  (override)"}`,
  );

  // ── Sanity: funder has SOL ─────────────────────────────────────────────────
  const { value: balance } = await rpc.getBalance(funder.address).send();
  if (balance < MIN_FUNDER_LAMPORTS) {
    throw new Error(
      `Funder ${shortAddr(funder.address)} has ${Number(balance) / 1e9} SOL — need ≥ ${Number(MIN_FUNDER_LAMPORTS) / 1e9}. Run \`solana airdrop 1 --url devnet\`.`,
    );
  }

  // ── Sanity: USDC mint exists on this cluster ───────────────────────────────
  const mint = await fetchMaybeMint(rpc, cli.usdcMint);
  if (!mint.exists) {
    throw new Error(
      `USDC mint ${cli.usdcMint} does not exist on this cluster. ` +
        `Either pass --usdc-mint=<pubkey> with a valid mint, or pick a different --rpc.`,
    );
  }
  console.log(
    `  mint check:    decimals=${mint.data.decimals}, supply=${mint.data.supply.toString()}`,
  );

  // ── PDA + idempotency ──────────────────────────────────────────────────────
  const [protocolConfigPda] = await findProtocolConfigPda();
  console.log(`  program_id:    ${BRACKET_CHAIN_PROGRAM_ADDRESS}`);
  console.log(`  config_pda:    ${protocolConfigPda}`);

  const existing = await fetchMaybeProtocolConfig(rpc, protocolConfigPda);
  if (existing.exists) {
    const cfg = existing.data;
    console.log("\n✅ ProtocolConfig already initialized:");
    console.log(`   authority:    ${cfg.authority}`);
    console.log(`   treasury:     ${cfg.treasury}`);
    console.log(`   default_mint: ${cfg.defaultMint}`);
    console.log(`   fee_bps:      ${cfg.feeBps}`);
    if (cfg.defaultMint !== cli.usdcMint) {
      console.log(
        `\n⚠️  on-chain default_mint differs from your --usdc-mint argument. Existing config wins; reinit is not possible without redeploying the program.`,
      );
    }
    return;
  }

  // ── Send initialize_protocol ───────────────────────────────────────────────
  console.log("\n  sending initialize_protocol...");
  const ix = await getInitializeProtocolInstructionAsync({
    authority: funder,
    protocolConfig: protocolConfigPda,
    treasury,
    defaultMint: cli.usdcMint,
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

  console.log(`\n✅ ProtocolConfig initialized.`);
  console.log(`   tx:         ${sig}`);
  console.log(
    `   explorer:   https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  );

  // ── Verify ─────────────────────────────────────────────────────────────────
  const verified = await fetchMaybeProtocolConfig(rpc, protocolConfigPda);
  if (verified.exists) {
    const cfg = verified.data;
    console.log(`   authority:    ${cfg.authority}`);
    console.log(`   treasury:     ${cfg.treasury}`);
    console.log(`   default_mint: ${cfg.defaultMint}`);
    console.log(`   fee_bps:      ${cfg.feeBps}`);
  }
}

main().catch((err) => {
  console.error("\n❌ initialization failed:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

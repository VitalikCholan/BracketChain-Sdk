/**
 * One-shot SAS bootstrap for the BracketChain protocol singleton on a live cluster.
 *
 * Calls `set_sas_config(sas_credential, sas_schemas[5])` so that `join_tournament`
 * can validate SAS identity attestations for game-tagged (non-Manual) tournaments.
 * Without this, every Dota 2 join reverts with error 6027 `WrongAttestationCredential`
 * (the on-chain `protocol_config.sas_credential` is still the zero pubkey).
 *
 * The credential + Dota 2 schema defaults below match the indexer's devnet values
 * (`bracket-chain-indexer/.env` → SAS_CREDENTIAL / SAS_SCHEMA_DOTA2). The two MUST
 * agree — the indexer issues attestations under that credential, and the program
 * checks them against what this script writes.
 *
 * Idempotent: if the on-chain config already matches the requested values, the
 * script prints them and exits 0 without sending a transaction. Re-running with
 * different values overwrites (the ix allows updates by the protocol authority).
 *
 * Usage:
 *   tsx scripts/set-sas-config.ts --check                  # read-only: print on-chain config + authority
 *   tsx scripts/set-sas-config.ts
 *   tsx scripts/set-sas-config.ts --rpc=https://devnet.helius-rpc.com/?api-key=KEY
 *   tsx scripts/set-sas-config.ts --credential=<pubkey> --schema-dota2=<pubkey>
 *   FUNDER_KEYPAIR=/path/id.json tsx scripts/set-sas-config.ts
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
  getSetSasConfigInstructionAsync,
} from "../src/generated";

// ─────────────────────────────────────────────────────────────────────────────
// Defaults — keep in lockstep with bracket-chain-indexer/.env (A-11 identity)
// ─────────────────────────────────────────────────────────────────────────────

// SAS Credential PDA the indexer's sas-issuer signs attestations under (devnet).
const DEFAULT_SAS_CREDENTIAL = address(
  "A6aCesF4nLNRGBRfUS5dCw9e1f1peGmNhZU4t139Qwjc",
);

// SAS Schema PDA for the Dota 2 game-identity shape (devnet).
const DEFAULT_SAS_SCHEMA_DOTA2 = address(
  "4TT2a5ycymMRwZJoGTPfaggb7CtGrDtCXKheF7zeV27m",
);

// Zero pubkey sentinel for SupportedGame slots without a schema yet
// (Manual needs none; Cs2Faceit / Valorant / LoL ship post-Phase-1).
const ZERO_ADDRESS = address("11111111111111111111111111111111");

const MIN_FUNDER_LAMPORTS = 1_000_000n; // 0.001 SOL — tx fee only, no rent

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

interface Cli {
  rpc: string;
  funderKeypair: string;
  credential: Address;
  schemaDota2: Address;
  checkOnly: boolean;
}

function parseCli(): Cli {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };

  const credentialArg = get("credential");
  const schemaArg = get("schema-dota2");

  return {
    rpc: get("rpc") ?? "https://api.devnet.solana.com",
    funderKeypair:
      get("funder") ??
      process.env.FUNDER_KEYPAIR ??
      path.join(os.homedir(), ".config", "solana", "id.json"),
    credential: credentialArg ? address(credentialArg) : DEFAULT_SAS_CREDENTIAL,
    schemaDota2: schemaArg ? address(schemaArg) : DEFAULT_SAS_SCHEMA_DOTA2,
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

  // SupportedGame discriminant order: Manual=0, Dota2=1, Cs2Faceit=2, Valorant=3, LoL=4.
  const sasSchemas: Address[] = [
    ZERO_ADDRESS, // Manual — no identity required
    cli.schemaDota2, // Dota2
    ZERO_ADDRESS, // Cs2Faceit — V1.3+
    ZERO_ADDRESS, // Valorant — V1.3+
    ZERO_ADDRESS, // LoL — V1.3+
  ];

  console.log(
    cli.checkOnly
      ? "BracketChain SAS config check (read-only)"
      : "BracketChain SAS config bootstrap",
  );
  console.log(`  rpc:            ${cli.rpc}`);
  console.log(`  sas_credential: ${cli.credential}  (desired)`);
  console.log(`  schema[Dota2]:  ${cli.schemaDota2}  (desired)`);

  // ── Fetch existing config ──────────────────────────────────────────────────
  const [protocolConfigPda] = await findProtocolConfigPda();
  console.log(`  program_id:     ${BRACKET_CHAIN_PROGRAM_ADDRESS}`);
  console.log(`  config_pda:     ${protocolConfigPda}`);

  const existing = await fetchMaybeProtocolConfig(rpc, protocolConfigPda);
  if (!existing.exists) {
    throw new Error(
      `ProtocolConfig does not exist on this cluster. Run \`tsx scripts/init-protocol.ts --rpc=${cli.rpc}\` first.`,
    );
  }

  const cfg = existing.data;
  console.log(`\n  on-chain authority:      ${cfg.authority}`);
  console.log(`  on-chain sas_credential: ${cfg.sasCredential}`);
  console.log(`  on-chain schema[Dota2]:  ${cfg.sasSchemas[1]}`);

  const alreadyMatches =
    cfg.sasCredential === cli.credential &&
    cfg.sasSchemas.length === sasSchemas.length &&
    cfg.sasSchemas.every((s, i) => s === sasSchemas[i]);

  if (cli.checkOnly) {
    console.log(
      alreadyMatches
        ? "\n✅ SAS config matches the desired values — joins should work."
        : `\n⚠️  SAS config does NOT match. The protocol authority (${shortAddr(cfg.authority)}) must run this script without --check.`,
    );
    return;
  }

  const rpcSubscriptions = createSolanaRpcSubscriptions(
    deriveWsEndpoint(cli.rpc),
  );
  const funder = await loadSigner(cli.funderKeypair);
  console.log(`  funder:         ${funder.address}`);

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
    console.log("\n✅ SAS config already matches — nothing to do.");
    return;
  }

  // ── Send set_sas_config ────────────────────────────────────────────────────
  console.log("\n  sending set_sas_config...");
  const ix = await getSetSasConfigInstructionAsync({
    authority: funder,
    protocolConfig: protocolConfigPda,
    sasCredential: cli.credential,
    sasSchemas,
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

  console.log(`\n✅ SAS config written.`);
  console.log(`   tx:         ${sig}`);
  console.log(
    `   explorer:   https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  );

  // ── Verify ─────────────────────────────────────────────────────────────────
  const verified = await fetchMaybeProtocolConfig(rpc, protocolConfigPda);
  if (verified.exists) {
    console.log(`   sas_credential: ${verified.data.sasCredential}`);
    console.log(`   schema[Dota2]:  ${verified.data.sasSchemas[1]}`);
  }
}

main().catch((err) => {
  console.error("\n❌ SAS config bootstrap failed:");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

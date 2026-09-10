#!/usr/bin/env node
// ctp-e2e.mjs — a REAL signed end-to-end of the CTP escrow against a live rnode.
//
// Unlike ctp-escrow-check.mjs (exploratory, revVault stubbed), this signs and
// deploys for real with a genesis-funded key, so it exercises the actual
// `rho:rchain:revVault` legs and `deployToNode`'s per-node nonce + result poll.
//
// Two escrows on the ONE local node stand in for two shards: escrow-A has
// shardId "shard-A", escrow-B "shard-B", each registers the other. The
// "deployer" key is the bridge owner (installs + mint); the "validator" key is
// the user (lock). Recipient = the validator address; we check its balance
// moved by the transfer amount.
//
//   bash scripts/localnet/run-node.sh        # one terminal
//   node scripts/localnet/ctp-e2e.mjs        # another
//     --node <url>   default http://127.0.0.1:40403

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// esbuild lives in packages/browser (this dir's deps are just @noble); reach it
// by path rather than adding a dependency here for one script.
const { build } = await import(join(HERE, "../../packages/browser/node_modules/esbuild/lib/main.js"));
const NODE = (() => { const i = process.argv.indexOf("--node"); return i > -1 ? process.argv[i + 1] : "http://127.0.0.1:40403"; })();

const keys = Object.fromEntries(
  readFileSync(join(HERE, "pk.txt"), "utf8").split("\n")
    .filter((l) => /^\w+=/.test(l)).map((l) => l.split("=")),
);

const bundleOf = async (entry) => {
  const b = await build({
    absWorkingDir: join(HERE, "../../packages/browser"),
    entryPoints: [join(HERE, "../../packages/browser/src", entry)],
    bundle: true, format: "esm", platform: "node", write: false,
    external: ["@quantum-os/zfa-core"],
  });
  return import("data:text/javascript;base64," + Buffer.from(b.outputFiles[0].text).toString("base64"));
};

const rho = await bundleOf("rholang.ts");
const escrow = await bundleOf("ctp-escrow.js");
const { deployToNode, revAddressOf, generateKey, evalTerm, DEFAULT_CONFIG } = rho;
const { installProgram, registerProgram, lockProgram, mintProgram } = escrow;

const cfgFor = (key) => ({ ...DEFAULT_CONFIG, url: NODE, key });
const ownerCfg = cfgFor(keys.deployer);
const userCfg = cfgFor(keys.validator);
// A fresh address with no genesis balance — so its delta is exactly the transfer.
const recipient = revAddressOf(generateKey());

const balance = async (addr) => {
  const r = await evalTerm(cfgFor(keys.deployer), `new rv(\`rho:rchain:revVault\`), r in { rv!("getBalance", "${addr}", *r) | for (@b <- r) { return!(b) } }`).catch(() => ({ values: [] }));
  return r.values?.[0];
};

let fail = 0;
const step = async (label, fn) => {
  process.stdout.write(`… ${label}\n`);
  try { const v = await fn(); console.log(`  ✓ ${label}${v ? `  ${v}` : ""}`); return v; }
  catch (e) { console.log(`  ✗ ${label} — ${e?.message ?? e}`); fail++; throw e; }
};

console.log(`ctp-e2e — ${NODE}`);
try {
  const s = await (await fetch(NODE + "/api/status")).json();
  console.log(`rnode ${s.version?.node} · shard ${s.shardId} · height ${s.latestBlockNumber}\n`);
} catch { console.error(`cannot reach ${NODE}`); process.exit(2); }

console.log(`owner (bridge) = ${revAddressOf(keys.deployer)}`);
console.log(`user           = ${revAddressOf(keys.validator)}`);
console.log(`recipient      = ${recipient}\n`);

try {
  const pool = revAddressOf(keys.deployer);

  const uriA = await step("install escrow-A (shard-A)", async () => {
    const o = await deployToNode(ownerCfg, NODE, installProgram(pool, "shard-A"), 40);
    if (!o.ok || !/^rho:id:/.test(String(o.value ?? "").trim())) throw new Error(o.message + " / " + o.value);
    return o.value.trim();
  });
  const uriB = await step("install escrow-B (shard-B)", async () => {
    const o = await deployToNode(ownerCfg, NODE, installProgram(pool, "shard-B"), 40);
    if (!o.ok || !/^rho:id:/.test(String(o.value ?? "").trim())) throw new Error(o.message + " / " + o.value);
    return o.value.trim();
  });

  await step("escrow-B registers shard-A", async () => {
    const o = await deployToNode(ownerCfg, NODE, registerProgram(uriB, "shard-A"), 40);
    if (!o.ok) throw new Error(o.message);
    return JSON.stringify(o.value);
  });

  const before = await step("recipient balance before", () => balance(recipient));

  const userAddr = revAddressOf(keys.validator);
  const burnTuple = await step("user locks 5 at escrow-A", async () => {
    const o = await deployToNode(userCfg, NODE, lockProgram(uriA, userAddr, 5, recipient, "e2e-1"), 40);
    if (!o.ok) throw new Error(o.message);
    if (!/^\(\s*"ctp-burn"/.test(String(o.value ?? "").trim())) throw new Error("no burn receipt: " + o.value);
    return o.value.trim();
  });

  await step("owner mints at escrow-B", async () => {
    const o = await deployToNode(ownerCfg, NODE, mintProgram(uriB, burnTuple), 40);
    if (!o.ok) throw new Error(o.message);
    if (!/^\(\s*"ctp-mint"/.test(String(o.value ?? "").trim())) throw new Error("no mint receipt: " + o.value);
    return o.value.trim();
  });

  const after = await step("recipient balance after", () => balance(recipient));
  await step("recipient balance moved by +5", async () => {
    const d = Number(after) - Number(before);
    if (d !== 5) throw new Error(`delta ${d} (before ${before}, after ${after})`);
    return `+${d}`;
  });
} catch { /* step already logged */ }

console.log(fail ? `\n${fail} step(s) FAILED` : "\nend-to-end OK — real REV crossed both escrows");
process.exit(fail ? 1 : 0);

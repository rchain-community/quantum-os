#!/usr/bin/env node
// captp-e2e.mjs — a REAL signed end-to-end of a CapTP bridge across TWO rnodes.
//
// Unlike captp-escrow-check.mjs (exploratory, revVault stubbed) this signs and
// deploys for real with genesis-funded keys, and exercises the exact path
// `/captp setup` + `/captp send` take: install the escrow on node A and node B,
// register each as the other's counterpart, `lock` on A, `mint` on B, and
// check the recipient's REV balance on B moved by the transfer amount.
//
//   bash scripts/localnet/run-node.sh                       # node A :40403
//   ... a second node on other ports ...                    # node B :41403
//   node scripts/localnet/captp-e2e.mjs
//     --a <url>   default http://127.0.0.1:40403
//     --b <url>   default http://127.0.0.1:41403

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// esbuild lives in packages/browser (this dir's deps are just @noble).
const { build } = await import(join(HERE, "../../packages/browser/node_modules/esbuild/lib/main.js"));
const flag = (f, d) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const URL_A = flag("--a", "http://127.0.0.1:40403");
const URL_B = flag("--b", "http://127.0.0.1:41403");

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
const escrow = await bundleOf("captp-escrow.js");
const { deployToNode, revAddressOf, generateKey, nodeStatus, evalTerm, DEFAULT_CONFIG } = rho;
const { installProgram, registerProgram, lockProgram, mintProgram } = escrow;

const cfgFor = (key, url) => ({ ...DEFAULT_CONFIG, url, key });
const pool = revAddressOf(keys.deployer);          // bridge owner (install + mint)
const userAddr = revAddressOf(keys.validator);     // the user (lock)
const recipient = revAddressOf(generateKey());     // fresh — delta == transfer

const balanceOn = async (url, addr) => {
  const r = await evalTerm(cfgFor(keys.deployer, url),
    `new rv(\`rho:rchain:revVault\`), r in { rv!("getBalance", "${addr}", *r) | for (@b <- r) { return!(b) } }`).catch(() => ({ values: [] }));
  return r.values?.[0];
};

let fail = 0;
const step = async (label, fn) => {
  process.stdout.write(`… ${label}\n`);
  try { const v = await fn(); console.log(`  ✓ ${label}${v ? `  ${v}` : ""}`); return v; }
  catch (e) { console.log(`  ✗ ${label} — ${e?.message ?? e}`); fail++; throw e; }
};

console.log(`captp-e2e — A ${URL_A}  ·  B ${URL_B}`);
const [sa, sb] = await Promise.all([
  nodeStatus(cfgFor(keys.deployer, URL_A)).catch(() => null),
  nodeStatus(cfgFor(keys.deployer, URL_B)).catch(() => null),
]);
if (!sa || !sb) { console.error(`cannot reach ${!sa ? URL_A : URL_B}`); process.exit(2); }
let idA = sa.shardId || "shard-a", idB = sb.shardId || "shard-b";
if (idA === idB) { idA += "-a"; idB += "-b"; }
console.log(`  A id ${idA} (h${sa.latestBlockNumber}) · B id ${idB} (h${sb.latestBlockNumber})`);
console.log(`  owner ${pool}\n  user  ${userAddr}\n  recipient ${recipient}\n`);

try {
  const uriA = await step(`install escrow on A (${idA})`, async () => {
    const o = await deployToNode(cfgFor(keys.deployer, URL_A), URL_A, installProgram(pool, idA), 40);
    if (!o.ok || !/^rho:id:/.test(String(o.value ?? "").trim())) throw new Error(o.message + " / " + o.value);
    return o.value.trim();
  });
  const uriB = await step(`install escrow on B (${idB})`, async () => {
    const o = await deployToNode(cfgFor(keys.deployer, URL_B), URL_B, installProgram(pool, idB), 40);
    if (!o.ok || !/^rho:id:/.test(String(o.value ?? "").trim())) throw new Error(o.message + " / " + o.value);
    return o.value.trim();
  });
  await step(`B trusts counterpart ${idA}`, async () => {
    const o = await deployToNode(cfgFor(keys.deployer, URL_B), URL_B, registerProgram(uriB, idA), 40);
    if (!o.ok) throw new Error(o.message);
    return JSON.stringify(o.value);
  });

  const before = await step("recipient balance on B, before", () => balanceOn(URL_B, recipient));

  const burnTuple = await step(`user locks 5 on A`, async () => {
    const o = await deployToNode(cfgFor(keys.validator, URL_A), URL_A, lockProgram(uriA, userAddr, 5, recipient, "e2e-1"), 40);
    if (!o.ok) throw new Error(o.message);
    if (!/^\(\s*"captp-burn"/.test(String(o.value ?? "").trim())) throw new Error("no burn receipt: " + o.value);
    return o.value.trim();
  });
  await step(`owner mints on B`, async () => {
    const o = await deployToNode(cfgFor(keys.deployer, URL_B), URL_B, mintProgram(uriB, burnTuple), 40);
    if (!o.ok) throw new Error(o.message);
    if (!/^\(\s*"captp-mint"/.test(String(o.value ?? "").trim())) throw new Error("no mint receipt: " + o.value);
    return o.value.trim();
  });

  const after = await step("recipient balance on B, after", () => balanceOn(URL_B, recipient));
  await step("recipient balance moved by +5", async () => {
    const d = Number(after) - Number(before);
    if (d !== 5) throw new Error(`delta ${d} (before ${before}, after ${after})`);
    return `+${d}`;
  });
} catch { /* step already logged */ }

console.log(fail ? `\n${fail} step(s) FAILED` : "\nend-to-end OK — real REV crossed from node A to node B");
process.exit(fail ? 1 : 0);

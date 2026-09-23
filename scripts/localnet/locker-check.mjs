#!/usr/bin/env node
// locker-check.mjs — does the locker still work on a chain?
//
// The companion to `node packages/browser/src/locker.js --selftest`, which
// checks that every program is well-formed and names the right verb but never
// leaves the browser. Two defects lived through that test for months: the call
// unwrapped a `(_, caps)` tuple that this node does not send, and the answer
// went only to a registry result slot this node does not write. Both made a
// healthy locker look absent. Hence this.
//
// Needs a funded key and a node, so not in CI.
//
//   node scripts/localnet/locker-check.mjs [--node <url>]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as L from "../../packages/browser/src/locker.js";
import { DEFAULT_CONFIG, deployTerm, revAddressOf } from "../qos-cli/rholang-client.mjs";
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const NODE = arg("--node", "https://rnodeapi.rhobot.net");
const pk = readFileSync(join(import.meta.dirname, "pk.txt"), "utf8");
const keyOf = (n) => pk.split("\n").find((l) => l.startsWith(`${n}=`))?.split("=")[1].trim();
const alice = keyOf("alice"), bob = keyOf("bob");
const cfg = (k) => ({ ...DEFAULT_CONFIG, url: NODE, key: k, phloLimit: 8_000_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
// The locker answers on `return`, which the deploy wrapper forwards to the
// key's result slot — the path that does not read back here. Read the block
// instead: find the deploy and report whether it errored, then read the slot.
async function run(label, key, program, check) {
  const r = await deployTerm(cfg(key), program, { waitAttempts: 0 });
  if (!r.ok) { fail++; console.log(`FAIL ${label}: ${String(r.message).slice(0, 160)}`); return null; }
  for (let i = 0; i < 16; i++) {
    await sleep(4000);
    let j; try { j = await (await fetch(`${NODE}/api/v1/deploy-status/${r.sig}`)).json(); } catch { continue; }
    if (j?.ProcessedWithError) { fail++; console.log(`FAIL ${label}: ${JSON.stringify(j.ProcessedWithError.deployError ?? j.ProcessedWithError).slice(0, 200)}`); return null; }
    if (j?.ProcessedWithSuccess) {
      const v = JSON.stringify(j.ProcessedWithSuccess.deployResult ?? []);
      const okc = check ? check(v) : true;
      if (okc) pass++; else fail++;
      console.log(`${okc ? "ok  " : "FAIL"} ${label}: ${v.slice(0, 180)}`);
      return v;
    }
  }
  fail++; console.log(`FAIL ${label}: not processed`); return null;
}
console.log(`locker check — ${NODE}  (programs exactly as the browser sends them)\n`);
const out = await run("install locker (alice)", alice, L.installProgram(), (v) => v.includes("rho:id:"));
const URI = (out ?? "").match(/rho:id:[a-z0-9]+/)?.[0];
if (!URI) { console.log("no uri — stopping"); process.exit(1); }
console.log(`  uri ${URI}\n`);
const withD = (p) => p;
await run("register (alice)", alice, withD(L.registerProgram(URI, revAddressOf(alice))),
  (v) => v.includes("registered"));
await run("register again — idempotent", alice, withD(L.registerProgram(URI, revAddressOf(alice))),
  (v) => v.includes("already"));
await run("bind a name", alice, withD(L.bindProgram(URI, "ballot", "rho:id:xyz")),
  (v) => v.includes("ballot"));
await run("resolve it", alice, withD(L.resolveProgram(URI, "ballot")),
  (v) => v.includes("rho:id:xyz"));
await run("BOB resolves alice's name — isolated", bob, withD(L.resolveProgram(URI, "ballot")),
  (v) => v === "[]" || !v.includes("xyz"));
await run("read the record", alice, withD(L.readProgram(URI)),
  (v) => v.includes(revAddressOf(alice)));
await run("grant a write-only cap for one name", alice, withD(L.grantProgram(URI, "ballot")),
  (v) => v.includes("Unforg"));
await run("an unknown verb is reported", alice, withD(L.lockerCall(URI, "nosuchverb", [])),
  (v) => v.includes("no verb"));
console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);

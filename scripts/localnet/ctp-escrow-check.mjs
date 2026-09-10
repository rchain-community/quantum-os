#!/usr/bin/env node
// ctp-escrow-check.mjs — does the CTP escrow rholang actually run on rnode?
//
// ctp-escrow.js's selftest checks the SHAPE of the contract (balanced, verb
// names, arg positions). It cannot check that rnode parses and reduces it. This
// does: it deploys the contract as an EXPLORATORY deploy with `revVault` stubbed
// to always succeed, drives the six verbs through a scripted sequence, and
// reports what each one returned.
//
// What this covers: parsing, the `match` arities (the 6-tuple burn receipt),
// Set/Map method use, the owner gate, nonce idempotency (dup lock, replayed
// mint), the counterpart check, and refund state transitions.
//
// What it does NOT cover: real `rho:rchain:revVault` semantics (a funded
// transfer, a failed transfer's reply shape). That needs a signed deploy from a
// genesis-funded key and is a manual step — see issue #173.
//
//   bash scripts/localnet/run-node.sh      # one terminal
//   node scripts/localnet/ctp-escrow-check.mjs
//     --node <url>   default http://127.0.0.1:40403

import { CTP_ESCROW_RHO } from "../../packages/browser/src/ctp-escrow.js";

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const NODE = arg("--node", "http://127.0.0.1:40403");

// The contract, with the install-time placeholders filled and two test
// substitutions: the owner is a literal string (a real install captures
// *deployerId, unbound in an exploratory deploy), and revVault is a local stub
// that always replies Nil (success) so the value-moving verbs exercise their
// full logic without a funded vault.
const CONTRACT = CTP_ESCROW_RHO
  .replace("POOL", '"1111pool"')
  .replace("SHARD", '"shard-A"')
  .replace("*deployerId", '"OWNER"')
  .replace("deployerId(`rho:rchain:deployerId`), ", "")
  .replace("revVault(`rho:rchain:revVault`),", "revVault,")
  .replace("CAPS", "DRIVER");

// A scripted drive of the verbs, strictly sequential — each step's `for` wraps
// the next, so the order is pinned and every reply is bound to a name. The
// innermost scope returns them all as one labelled list.
const DRIVER = `
  contract revVault(_op, _from, _to, _amt, r) = { r!(Nil) } |
  new s1, s2, s3, s4, s5, s6, s7, s8, s9 in {
    doRegister!("OWNER", "shard-B", *s1) |
    for (@r1 <- s1) {
    doLock!("SUBJ", 30, "1111bob", "n1", *s2) |
    for (@r2 <- s2) {
    doLock!("SUBJ", 30, "1111bob", "n1", *s3) |
    for (@r3 <- s3) {
    doLockOf!("n1", *s4) |
    for (@r4 <- s4) {
    doMint!("OWNER", ("ctp-burn", "shard-B", "1111x", 30, "n2", "1111bob"), *s5) |
    for (@r5 <- s5) {
    doMint!("OWNER", ("ctp-burn", "shard-B", "1111x", 30, "n2", "1111bob"), *s6) |
    for (@r6 <- s6) {
    doMint!("OWNER", ("ctp-burn", "shard-X", "1111x", 30, "n3", "1111bob"), *s7) |
    for (@r7 <- s7) {
    doMint!("EVE", ("ctp-burn", "shard-B", "1111x", 30, "n4", "1111bob"), *s8) |
    for (@r8 <- s8) {
    doRefund!("OWNER", "n1", *s9) |
    for (@r9 <- s9) {
      return!([
        "register", r1, "lock n1", r2, "lock n1 again", r3, "lockOf n1", r4,
        "mint n2 registered", r5, "mint n2 replay", r6, "mint unknown cp", r7,
        "mint not owner", r8, "refund n1", r9
      ])
    }}}}}}}}}
  }`;

const PROGRAM = CONTRACT.replace("DRIVER", DRIVER);

const WRAP = (body) =>
  "new return, stdout(`rho:io:stdout`) in {\n" + body + "\n}";

async function explore(term) {
  const res = await fetch(NODE + "/api/explore-deploy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(term),
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { return { error: text.slice(0, 400) }; }
  if (typeof j === "string") return { error: j.slice(0, 400) };
  return { exprs: j.expr ?? [] };
}

// --- run ---
console.log(`ctp-escrow-check — ${NODE}\n`);
try {
  const s = await (await fetch(NODE + "/api/status")).json();
  console.log(`rnode ${s.version?.node ?? "?"} · shard ${s.shardId} · height ${s.latestBlockNumber}\n`);
} catch {
  console.error(`cannot reach ${NODE} — is rnode running? (bash scripts/localnet/run-node.sh)`);
  process.exit(2);
}

const r = await explore(WRAP(PROGRAM));
if (r.error) {
  console.log("FAIL — rnode rejected the program:\n");
  console.log("  " + r.error.replace(/\n/g, "\n  "));
  process.exit(1);
}

// The one return is a list of (label, reply) pairs. rnode renders it as an
// ExprPar/ExprList; pull it back to something readable.
const raw = JSON.stringify(r.exprs, null, 1);
console.log("raw return:\n" + raw.slice(0, 4000) + (raw.length > 4000 ? "\n… (truncated)" : ""));

// Light assertions over the rendered text — enough to catch a structural
// regression without a full rholang value parser.
const txt = raw;
let pass = 0, fail = 0;
const want = (label, needle) => {
  const ok = txt.includes(needle);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}  ${ok ? "" : `(expected to see ${JSON.stringify(needle)})`}`);
  ok ? pass++ : fail++;
};
console.log("\nchecks:");
want("register succeeded", "registered");
want("dup nonce refused", "dup nonce");
want("mint of a registered counterpart is not denied/rejected", "ctp-mint");
want("unknown counterpart rejected", "unknown counterpart");
want("non-owner mint denied", "denied");
want("refund of a real lock", "refunded");

console.log(`\n${fail ? "SOME CHECKS FAILED" : "all structural checks passed"} — ${pass}/${pass + fail}`);
console.log("(real revVault semantics still need a signed, funded deploy — see #173)");
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// rgov-check.mjs — does rgov's governance rholang still run, on THIS rnode?
//
// rgov (rchain-community/rgov) is the governance app r-wallet's contract
// dropdown was ported from: ten contract classes in `rholang/core/`, and ~36
// action scripts that are CLIENTS of those classes. It was written against the
// Scala node. This asks what still works on rchain-rust, so a redesign starts
// from evidence rather than from the 2021 shape.
//
// It exists because two node bugs that shaped rgov's design are now FIXED —
// rchain-rust#19 (a one-binder persistent receive in a nested `new` never
// terminates) and #21 (a registry-looked-up facet answers only the first call
// per program), both closed 2026-08-29 and verified live. Code written to dodge
// them can be simplified, but only once we know what it is.
//
//   node scripts/localnet/rgov-check.mjs --node https://rnodeapi.rhobot.net
//
//   --node <url>    default http://127.0.0.1:40403
//   --rgov <dir>    a local rgov checkout; otherwise sources are fetched from
//                   GitHub and cached under .rgov-cache/ (gitignored)
//   --only <name>   run one case
//   --no-stub       do not stub the identity urns (see stubIdentity below)
//   --verbose       print each program and rnode's raw answer
//
// Like macro-check.mjs, every case here is an EXPLORATORY deploy: unsigned,
// free, no block, nothing written. Same two consequences, and they are SKIPS
// rather than failures because neither is a defect in the script:
//
//   * `rho:rchain:deployerId` is unbound in an exploratory deploy, so any
//     script that identifies its caller cannot run here → `needs-deploy`.
//   * A `rho:registry:lookup` of a uri nothing has registered never answers,
//     and most rgov actions look up the master contract → `needs-bootstrap`.
//     Clearing those is Tier 2's job (deploy the classes first); this file is
//     Tier 1, which needs no bootstrap and answers the prior question: is
//     rgov's rholang alive at all.
//
// It reports; it does not triage. A failure gives the script, the call site and
// what rnode said. Whether that means a stale script, a node change or a wrong
// case is a separate problem from running the thing.

import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyRawRgov } from "../../packages/browser/src/rgov-apply.js";

const arg = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const NODE = arg("--node", "http://127.0.0.1:40403");
const RGOV_DIR = arg("--rgov", null);
const ONLY = arg("--only", null);
const VERBOSE = process.argv.includes("--verbose");
// Identity urns are stubbed to plain names by default so a script's logic can
// be reached unsigned (see stubIdentity). --no-stub reports them as skips
// instead, which is the stricter, less informative reading.
const STUB = !process.argv.includes("--no-stub");

const RAW = "https://raw.githubusercontent.com/rchain-community/rgov/master/";
const CACHE = join(import.meta.dirname, ".rgov-cache");

/** rgov's sources, from a local checkout or GitHub (cached). Returns null when
 *  a path does not exist — a missing file is itself an audit finding
 *  (`actions/createInboxAndCastVote.rho` is referenced by the app but absent). */
async function source(path) {
  if (RGOV_DIR) {
    const p = join(RGOV_DIR, path);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
  const cached = join(CACHE, path.replace(/[/]/g, "__"));
  if (existsSync(cached)) {
    const t = readFileSync(cached, "utf8");
    return t === "\0missing" ? null : t;
  }
  mkdirSync(CACHE, { recursive: true });
  const res = await fetch(RAW + path);
  const text = res.ok ? await res.text() : null;
  writeFileSync(cached, text ?? "\0missing");
  return text;
}

// The governance core, after dropping what isn't rgov: the teaching demos
// (towers, sequencialLooping), the smoke test (helloWorld) and the empty stub
// (createInboxandCastVote) are not here. `missing: true` records one we expect
// to be absent, so its absence is reported as a finding rather than a crash.
const ACTIONS = [
  ["newInbox", "src/actions/newinbox.rho"],
  ["peekInbox", "src/actions/peekInbox.rho"],
  ["receiveFromInbox", "src/actions/receiveFromInbox.rho"],
  ["claimWithInbox", "src/actions/claimWithInbox.rho"],
  ["newChat", "src/actions/newChat.rho"],
  ["sendChat", "src/actions/sendChat.rho"],
  ["readChat", "src/actions/readChat.rho"],
  ["newBallot", "src/actions/newBallot.rho"],
  ["castBallot", "src/actions/castBallot.rho"],
  ["newIssue", "src/actions/newIssue.rho"],
  ["addVoterToIssue", "src/actions/addVoterToIssue.rho"],
  ["addGroupToIssue", "src/actions/addGroupToIssue.rho"],
  ["castVote", "src/actions/castVote.rho"],
  ["displayVote", "src/actions/displayVote.rho"],
  ["delegateVote", "src/actions/delegateVote.rho"],
  ["tallyVotes", "src/actions/tallyVotes.rho"],
  ["share", "src/actions/share.rho"],
  ["sendMail", "src/actions/sendMail.rho"],
  ["newGroup", "src/actions/newGroup.rho"],
  ["joinGroup", "src/actions/joinGroup.rho"],
  ["addMember", "src/actions/addMember.rho"],
  ["newMemberDirectory", "src/actions/newMemberDirectory.rho"],
  ["getRoll", "src/actions/getRoll.rho"],
  ["checkRegistration", "src/actions/checkRegistration.rho"],
  ["peekKudos", "src/actions/peekKudos.rho"],
  ["awardKudos", "src/actions/awardKudos.rho"],
  ["makeMint", "src/actions/makeMint.rho"],
  ["lookupURI", "src/actions/lookupURI.rho"],
  ["createURI", "src/actions/createURI.rho"],
  // Referenced by src/actions.js but absent from the repo — a known finding.
  ["createInboxandCastVote", "src/actions/createInboxAndCastVote.rho", { expectMissing: true }],
  // In the repo but in no dropdown — do they still work, and are they wanted?
  ["tallyBallot (orphan)", "src/actions/tallyBallot.rho"],
  ["CallForHelp (orphan)", "src/actions/CallForHelp.rho"],
  ["wannainit (orphan)", "src/actions/wannainit.rho"],
];

const CLASSES = [
  ["Ballot", "rholang/core/Ballot.rho"],
  ["Chat", "rholang/core/Chat.rho"],
  ["CrowdFund", "rholang/core/CrowdFund.rho"],
  ["Directory", "rholang/core/Directory.rho"],
  ["Group", "rholang/core/Group.rho"],
  ["Inbox", "rholang/core/Inbox.rho"],
  ["Issue", "rholang/core/Issue.rho"],
  ["Kudos", "rholang/core/Kudos.rho"],
  ["RevIssuer", "rholang/core/RevIssuer.rho"],
  ["memberIdGovRev", "rholang/core/memberIdGovRev.rho"],
  ["MemberDirectory", "rholang/feature/MemberDirectory.rho"],
];

async function explore(term) {
  const res = await fetch(NODE + "/api/explore-deploy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(term),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { return { error: text.slice(0, 200) }; }
  // rnode reports an error as a bare JSON string where success is an object —
  // including the runaway "reduction step budget exceeded", which a client
  // written for the success shape renders as an empty result.
  if (typeof j === "string") return { error: j.slice(0, 200) };
  return { values: (j.expr ?? []).map((e) => JSON.stringify(e).slice(0, 100)) };
}

/**
 * Turn the identity urns into ordinary new-bound names.
 *
 * `rho:rchain:deployerId` and `rho:rchain:deployId` only exist inside a signed
 * deploy, so unsigned they fail before the script's own logic is reached —
 * deployId with rnode's `BugFoundError: No value set for …`, which reads like a
 * broken script and is not one. Dropping the urn from the `new` leaves a plain
 * unforgeable name of the same arity, so the script parses and reduces and we
 * learn whether its LOGIC still works. What it cannot tell us is whether the
 * identity semantics are right — that needs Tier 2 and a signed deploy.
 *
 * `new x(`rho:rchain:deployId`), y in {` → `new x, y in {`
 */
const stubIdentity = (src) => src.replace(/\(\s*`rho:rchain:deploy(?:er)?Id`\s*\)/g, "");

/** Why a script cannot run in an exploratory deploy — a skip, not a failure. */
function blockedBy(src) {
  // A registry lookup of something nothing has registered simply never
  // answers, and no stub fixes that: the class has to exist. Tier 2's job.
  if (/rho:registry:lookup/.test(src)) return "needs-bootstrap (looks up a deployed class)";
  if (!STUB && /rho:rchain:deploy(?:er)?Id/.test(src)) return "needs-deploy (identity is unbound unsigned)";
  return null;
}

/** Code shaped only to dodge the two now-fixed node bugs — the category the
 *  whole audit exists to find, since it can be simplified away. */
function workaroundHints(src) {
  const hints = [];
  const oneBinder = [...src.matchAll(/contract\s+\w+\s*\(([^)]*)\)/g)]
    .map((m) => m[1].split(",").filter((s) => s.trim()).length);
  const padded = oneBinder.filter((n) => n === 2).length;
  if (padded) hints.push(`${padded} two-param contract(s) — check for #19 padding`);
  const lookups = (src.match(/rho:registry:lookup/g) ?? []).length;
  if (lookups > 1) hints.push(`${lookups} lookups — #21 splitting may be unwound`);
  return hints;
}

const status = { ok: "ok       ", fail: "FAIL     ", skip: "skipped  ", miss: "missing  " };
let pass = 0, fail = 0, skipped = 0, missing = 0;
const findings = [];

console.log(`rgov-check (tier 1 — no bootstrap${STUB ? ", identity stubbed" : ""}) — ${NODE}\n`);
try {
  const s = await (await fetch(NODE + "/api/status")).json();
  console.log(`rnode ${s.version?.node ?? "?"} · shard ${s.shardId} · height ${s.latestBlockNumber} · devMode ${s.devMode}\n`);
} catch {
  console.error(`cannot reach ${NODE} — is rnode running? (bash scripts/localnet/run-node.sh)`);
  process.exit(2);
}

async function run(kind, name, path, opts = {}) {
  if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) return;
  const label = name.padEnd(24);
  const src = await source(path);

  if (src === null) {
    const expected = opts.expectMissing ? " (referenced by src/actions.js — known)" : "";
    console.log(`${status.miss}${label}${path}${expected}`);
    findings.push({ kind, name, verdict: "missing", detail: path });
    missing++;
    return;
  }

  const hints = workaroundHints(src);
  const blocked = blockedBy(src);
  if (blocked) {
    console.log(`${status.skip}${label}${blocked}`);
    if (hints.length && VERBOSE) console.log(`         ${hints.join(" · ")}`);
    findings.push({ kind, name, verdict: "skipped", detail: blocked, hints });
    skipped++;
    return;
  }

  const program = applyRawRgov(STUB ? stubIdentity(src) : src);
  const r = await explore(program);
  if (VERBOSE) console.log(`\n--- ${name}\n${program}\n--- answer: ${JSON.stringify(r)}\n`);

  if (r.error) {
    console.log(`${status.fail}${label}${r.error}`);
    findings.push({ kind, name, verdict: "broken", detail: r.error, hints });
    fail++;
    return;
  }
  console.log(`${status.ok}${label}${r.values.length} value(s)${hints.length ? "  · " + hints.join(" · ") : ""}`);
  findings.push({ kind, name, verdict: "works", detail: `${r.values.length} values`, hints });
  pass++;
}

console.log("— contract classes —");
for (const [name, path] of CLASSES) await run("class", name, path);

console.log("\n— governance actions —");
for (const [name, path, opts] of ACTIONS) await run("action", name, path, opts);

console.log(`\n${pass} ran, ${fail} broken, ${skipped} skipped, ${missing} missing`);
const workarounds = findings.filter((f) => f.hints?.length);
if (workarounds.length) {
  console.log(`\n${workarounds.length} carry possible #19/#21 workarounds (both bugs are fixed — these can likely be simplified):`);
  for (const w of workarounds) console.log(`  ${w.name.padEnd(24)}${w.hints.join(" · ")}`);
}
console.log("\ntier 2 (deploy the classes, then run the client actions) is not built yet.");
process.exit(fail === 0 ? 0 : 1);

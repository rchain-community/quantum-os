// e2e: `/<cmd> list [n]` — the room's screen history.
//
// In-process signaling relay + the real agent.mjs (as scribe) + one driver peer.
// The driver talks, then asks `/scribe list N` and checks the reply.
// Run: node list-cmd.e2e.mjs
import { startRelay } from "./mini-relay.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QOSPeer } from "./qospeer.mjs";
import { generateCapability } from "./zfa.mjs";
import { run } from "./agent.mjs";

const PORT = 4459;
const ROOM = generateCapability("room");

// ---- minimal signaling relay (shared: mini-relay.mjs) ----
const { wss } = startRelay(PORT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateDir = mkdtempSync(join(tmpdir(), "scribe-e2e-"));
let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fail++; };

// ---- the scribe (real agent.mjs) — runs until the process exits ----
run({ signal: `ws://127.0.0.1:${PORT}`, room: ROOM, role: "scribe", state: stateDir, verbose: false })
  .catch((e) => { console.error("agent crashed:", e); process.exit(1); });

// ---- driver peer ----
let listReply = null;
const driver = new QOSPeer({
  signalingUrl: `ws://127.0.0.1:${PORT}`, roomId: ROOM, peerId: generateCapability("peer"),
  onMessage: (_from, d) => { if (d?.kind === "chat" && /📜/.test(d.text || "")) listReply = d.text; },
  onError: () => {},
});
driver.connect();

try {
  // wait for the channel
  for (let i = 0; i < 60 && driver.channels.size === 0; i++) await sleep(250);
  ok(driver.channels.size > 0, "driver connected to the scribe");
  await sleep(500);

  driver.broadcast({ kind: "name", name: "tester" });
  await sleep(300);
  for (const line of ["first thing said", "second thing said", "third thing said", "fourth thing said"]) {
    driver.broadcast({ kind: "chat", text: line });
    await sleep(150);
  }
  driver.broadcast({ kind: "qlf", cmd: "qucalc", arg: "^v", lines: ["closes to +I"] });
  await sleep(400);

  driver.broadcast({ kind: "chat", text: "/scribe list 3" });
  for (let i = 0; i < 40 && !listReply; i++) await sleep(250);

  ok(!!listReply, "scribe answered /scribe list");
  if (listReply) {
    const body = listReply.split("\n");
    ok(/last 3 of \d+ lines/.test(body[0]), `header names the count  — "${body[0]}"`);
    ok(body.length === 4, `3 lines returned (+header), got ${body.length - 1}`);
    ok(/third thing said/.test(listReply) && /fourth thing said/.test(listReply), "returns the most recent lines");
    ok(/\/qucalc \^v → closes to \+I/.test(listReply), "qlf command results are in the history");
    ok(!/first thing said/.test(listReply), "older lines excluded by n=3");
    ok(/^\d\d:\d\d \w+: /m.test(listReply), "line format: HH:MM name: text");
    ok(!body.slice(1).some((l) => /\/scribe (list|help|trust)/.test(l)), "control commands are not in the history");
  }

  // default (no n) → 25
  await sleep(2500);
  listReply = null;
  driver.broadcast({ kind: "chat", text: "/scribe list" });
  for (let i = 0; i < 40 && !listReply; i++) await sleep(250);
  ok(listReply && /last \d+ of \d+ lines/.test(listReply), "bare /scribe list works (default 25)");

  // clamp: absurd n
  await sleep(2500);
  listReply = null;
  driver.broadcast({ kind: "chat", text: "/scribe list 99999" });
  for (let i = 0; i < 40 && !listReply; i++) await sleep(250);
  ok(listReply && !/99999/.test(listReply.split("\n")[0]), "n is clamped to <= 500");
} finally {
  try { driver.disconnect(); } catch {}
  try { wss.close(); } catch {}
  rmSync(stateDir, { recursive: true, force: true });
  await sleep(200);
  console.log(fail ? `\n${fail} FAILED` : "\nlist-cmd e2e: all passed");
  process.exit(fail ? 1 : 0);
}

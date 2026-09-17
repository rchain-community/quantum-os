// e2e: the `observer` role — record a live game, materialize the record.
//
// In-process signaling relay + the real agent.mjs (as observer) + one driver peer.
// The driver pre-registers a game (`/observer start …`), plays a poll and a lemma,
// closes it (`/observer stop`), and checks the replies and the record on disk.
// Run: node observer.e2e.mjs
import { WebSocketServer } from "ws";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QOSPeer } from "./qospeer.mjs";
import { generateCapability } from "./zfa.mjs";
import { run } from "./agent.mjs";

const PORT = 4461;
const ROOM = generateCapability("room");

// ---- minimal signaling relay (as in list-cmd.e2e.mjs) ----
const rooms = new Map();
const wsPeer = new Map();
const wss = new WebSocketServer({ port: PORT });
const send = (ws, m) => { try { ws.send(JSON.stringify(m)); } catch {} };
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === "join") {
      const room = rooms.get(m.roomId) ?? new Map();
      rooms.set(m.roomId, room);
      wsPeer.set(ws, { roomId: m.roomId, peerId: m.peerId });
      const others = [...room.keys()];
      room.set(m.peerId, ws);
      send(ws, { type: "peers", roomId: m.roomId, peers: others });
      for (const [pid, pws] of room) if (pid !== m.peerId) send(pws, { type: "joined", roomId: m.roomId, peerId: m.peerId });
    } else if (m.type === "offer" || m.type === "answer" || m.type === "ice") {
      const tgt = rooms.get(m.roomId)?.get(m.to);
      if (tgt) send(tgt, m);
    } else if (m.type === "leave") {
      const info = wsPeer.get(ws); const room = info && rooms.get(info.roomId);
      if (room) { room.delete(info.peerId); for (const pws of room.values()) send(pws, { type: "left", roomId: info.roomId, peerId: info.peerId }); }
    }
  });
  ws.on("close", () => {
    const info = wsPeer.get(ws); wsPeer.delete(ws);
    const room = info && rooms.get(info.roomId);
    if (room) { room.delete(info.peerId); for (const pws of room.values()) send(pws, { type: "left", roomId: info.roomId, peerId: info.peerId }); }
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stateDir = mkdtempSync(join(tmpdir(), "observer-e2e-"));
let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fail++; };

run({ signal: `ws://127.0.0.1:${PORT}`, room: ROOM, role: "observer", state: stateDir, verbose: false })
  .catch((e) => { console.error("agent crashed:", e); process.exit(1); });

const replies = [];
const unprompted = [];
const driver = new QOSPeer({
  signalingUrl: `ws://127.0.0.1:${PORT}`, roomId: ROOM, peerId: generateCapability("peer"),
  onMessage: (_from, d) => { if (d?.kind === "chat") { replies.push(d.text || ""); } },
  onError: () => {},
});
driver.connect();
const waitFor = async (re, tries = 40) => { for (let i = 0; i < tries; i++) { const r = replies.find((t) => re.test(t)); if (r) return r; await sleep(250); } return null; };

try {
  for (let i = 0; i < 60 && driver.channels.size === 0; i++) await sleep(250);
  ok(driver.channels.size > 0, "driver connected to the observer");
  driver.broadcast({ kind: "name", name: "tester" });
  await sleep(1500);
  driver.broadcast({ kind: "chat", text: "hello room" });
  await sleep(2500);
  ok(replies.length === 0, `observer stays silent unprompted (got ${replies.length} messages)`);

  // pre-register + start
  driver.broadcast({ kind: "chat", text: '/observer start Stag Hunt e2e payoffs 4,0,3,2 stag="ambitious" hare="safe" predict: cold picks safe; commitment flips it' });
  const started = await waitFor(/Recording \*\*Stag Hunt e2e\*\*/);
  ok(!!started, "observer acknowledges /observer start");
  ok(started && /payoff-dominant S, risk-dominant H/.test(started), "start reply names payoff- and risk-dominant options");
  ok(started && /p\*=0\.67/.test(started), "start reply names the basin threshold p*");

  // a poll, ballots, close; an estimate; a lemma
  driver.broadcast({ kind: "poll-open", id: "P1", question: "ambitious or safe?", method: "approval", options: [{ id: "o1", text: "ambitious", by: "tester", at: 1 }, { id: "o2", text: "safe", by: "tester", at: 1 }], creator: driver.peerId, creatorLabel: "tester", createdAt: Date.now() });
  await sleep(150);
  driver.broadcast({ kind: "poll-ballot", pollId: "P1", choices: ["o2"] });
  await sleep(150);
  driver.broadcast({ kind: "poll-close", pollId: "P1" });
  driver.broadcast({ kind: "estimate-open", id: "E1", question: "how many commit?", tally: "median" });
  driver.broadcast({ kind: "estimate-value", id: "E1", value: 2 });
  driver.broadcast({ kind: "estimate-close", id: "E1" });
  driver.broadcast({ kind: "lemma", name: "commit-ambitious", twists: "^v", who: "tester", text: "I commit" });
  await sleep(800);

  driver.broadcast({ kind: "chat", text: "/observer status" });
  const st = await waitFor(/Recording \*\*Stag Hunt e2e\*\* since/);
  ok(!!st && /\d+ events so far/.test(st), "status reports the running recording and its event count");

  driver.broadcast({ kind: "chat", text: "/observer stop" });
  const stopped = await waitFor(/Recorded \*\*Stag Hunt e2e\*\*/);
  ok(!!stopped, "observer acknowledges /observer stop");
  ok(stopped && /1 poll\b/.test(stopped) && /1 estimate round/.test(stopped) && /1 lemma\b/.test(stopped), `stop reply counts poll/estimate/lemma — "${(stopped || "").slice(0, 160)}"`);
  ok(stopped && /→ safe/.test(stopped), "stop reply reports the poll winner");

  // the record on disk
  const roomHex = ROOM.replace(/^cap:room:/, "");
  const gamesDir = join(stateDir, "rooms", roomHex, "games");
  const files = existsSync(gamesDir) ? readdirSync(gamesDir) : [];
  const recFile = files.find((f) => f.endsWith(".json"));
  const evFile = files.find((f) => f.endsWith(".events.jsonl"));
  ok(!!recFile && !!evFile, `record + events files written (${files.join(", ")})`);
  if (recFile) {
    const rec = JSON.parse(readFileSync(join(gamesDir, recFile), "utf8"));
    ok(rec.schema === "qos-game/1", "record schema tagged");
    ok(rec.spec?.payoffs?.a === 4 && rec.spec?.predictions?.length === 2, "spec parsed: payoffs and two predictions");
    ok(rec.polls.length === 1 && rec.polls[0].tally.winners[0] === "safe" && rec.polls[0].ballots.length === 1, "poll materialized with ballot and tally");
    ok(rec.estimates.length === 1 && rec.estimates[0].summary.median === 2, "estimate materialized");
    ok(rec.lemmas.length === 1 && rec.lemmas[0].name === "commit-ambitious", "lemma materialized");
    ok(!!rec.participants[driver.peerId]?.name && rec.participants[driver.peerId].name === "tester", "participant named");
    ok(rec.chat.some((c) => /observer start/.test(c.text)), "the start command (pre-registration) is in the record");
    ok(rec.eventRange && rec.eventRange.first <= rec.eventRange.last, "event range recorded");
  }
  const idx = JSON.parse(readFileSync(join(stateDir, "rooms", roomHex, "games.json"), "utf8"));
  ok(idx.length === 1 && idx[0].label === "Stag Hunt e2e", "games index updated");

  driver.broadcast({ kind: "chat", text: "/observer games" });
  const lst = await waitFor(/Games recorded \(1\)/);
  ok(!!lst && /Stag Hunt e2e/.test(lst), "/observer games lists the game");

  driver.broadcast({ kind: "chat", text: "/observer summarize" });
  const sum = await waitFor(/AI mode|Summarizing/);
  ok(!!sum && /AI mode/.test(sum), "summarize without --ai explains and points at the record");
} finally {
  try { driver.disconnect(); } catch {}
  try { wss.close(); } catch {}
  rmSync(stateDir, { recursive: true, force: true });
  await sleep(200);
  console.log(fail ? `\n${fail} FAILED` : "\nobserver e2e: all passed");
  process.exit(fail ? 1 : 0);
}

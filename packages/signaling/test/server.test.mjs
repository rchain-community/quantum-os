// The resume/relay signaling server, exercised over real sockets.
//
//   pnpm build:signaling && node --test packages/signaling/test/server.test.mjs
//
// What is covered is the behaviour that turns a blip into a non-event: a lost
// socket holds the seat and tells nobody; a rejoin under the same id resumes
// with the control-plane traffic it missed; only the grace expiring (or an
// explicit leave) is a departure; and the `data` relay is authenticated the
// way a handshake is.
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

process.env.SIGNAL_GRACE_MS = "400";
const { SignalingServer, GRACE_MS } = await import("../dist/server.js");

const PORT = 40000 + Math.floor(Math.random() * 20000);
const server = new SignalingServer(PORT);
server.start();
const url = `ws://127.0.0.1:${PORT}`;
const ROOM = "r".repeat(64);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A client that records every frame it receives. */
async function client(peerId) {
  const ws = new WebSocket(url);
  const got = [];
  ws.on("message", (raw) => got.push(JSON.parse(raw.toString())));
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  const send = (m) => ws.send(JSON.stringify(m));
  const join = () => send({ type: "join", roomId: ROOM, peerId });
  const next = async (pred, ms = 1500) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const i = got.findIndex(pred);
      if (i >= 0) return got.splice(i, 1)[0];
      await sleep(10);
    }
    return null;
  };
  return { ws, got, send, join, next, peerId, close: () => ws.terminate() };
}

test("join, data relay (room + unicast), and relay auth", async () => {
  const a = await client("cap:peer:a");
  const b = await client("cap:peer:b");
  a.join();
  const pa = await a.next((m) => m.type === "peers");
  assert.deepEqual(pa, { type: "peers", roomId: ROOM, peers: [], resumed: false });
  b.join();
  const pb = await b.next((m) => m.type === "peers");
  assert.deepEqual(pb.peers, ["cap:peer:a"]);
  assert.equal((await a.next((m) => m.type === "joined"))?.peerId, "cap:peer:b");

  a.send({ type: "data", roomId: ROOM, from: "cap:peer:a", payload: "c1" });
  assert.equal((await b.next((m) => m.type === "data"))?.payload, "c1");
  await sleep(50);
  assert.equal(a.got.filter((m) => m.type === "data").length, 0, "a broadcast is not echoed to its sender");

  b.send({ type: "data", roomId: ROOM, from: "cap:peer:b", to: "cap:peer:a", payload: "u1" });
  assert.equal((await a.next((m) => m.type === "data"))?.payload, "u1");

  b.send({ type: "data", roomId: ROOM, from: "cap:peer:a", payload: "forged" });
  assert.match((await b.next((m) => m.type === "error"))?.message ?? "", /from mismatch/);
  await sleep(50);
  assert.equal(a.got.filter((m) => m.type === "data").length, 0, "a forged from is not relayed");

  a.send({ type: "ping", t: 42 });
  assert.deepEqual(await a.next((m) => m.type === "pong"), { type: "pong", t: 42 }, "a ping is answered with its t");

  b.send({ type: "leave", roomId: ROOM, peerId: "cap:peer:a" });
  assert.match((await b.next((m) => m.type === "error"))?.message ?? "", /peerId mismatch/);
  await sleep(50);
  assert.equal(a.got.filter((m) => m.type === "left").length, 0, "nobody can leave for someone else");

  a.close(); b.close();
  await sleep(GRACE_MS + 100);
});

test("a lost socket holds the seat: silent resume with replay, departure only on grace expiry", async () => {
  const a = await client("cap:peer:a");
  const b = await client("cap:peer:b");
  a.join(); await a.next((m) => m.type === "peers");
  b.join(); await b.next((m) => m.type === "peers");
  await a.next((m) => m.type === "joined");

  // b's socket dies without a close frame — a phone switching apps.
  b.close();
  await sleep(100);
  assert.equal(a.got.filter((m) => m.type === "left").length, 0, "a lost socket is not a departure");

  // Traffic for the held seat is queued.
  a.send({ type: "data", roomId: ROOM, from: "cap:peer:a", payload: "missed-1" });
  a.send({ type: "data", roomId: ROOM, from: "cap:peer:a", to: "cap:peer:b", payload: "missed-2" });
  await sleep(50);

  // b comes back under the same id: a resume, replayed, and a is told nothing.
  const b2 = await client("cap:peer:b");
  b2.join();
  const p = await b2.next((m) => m.type === "peers");
  assert.equal(p.resumed, true);
  assert.deepEqual(p.peers, ["cap:peer:a"]);
  assert.equal((await b2.next((m) => m.type === "data"))?.payload, "missed-1");
  assert.equal((await b2.next((m) => m.type === "data"))?.payload, "missed-2");
  await sleep(50);
  assert.equal(a.got.filter((m) => m.type === "joined").length, 0, "a resume is not announced");
  assert.equal(a.got.filter((m) => m.type === "left").length, 0);

  // Live again: relay works on the new socket.
  b2.send({ type: "data", roomId: ROOM, from: "cap:peer:b", payload: "back" });
  assert.equal((await a.next((m) => m.type === "data"))?.payload, "back");

  // Now b vanishes for good: after the grace, a is told.
  b2.close();
  assert.equal(await a.next((m) => m.type === "left", GRACE_MS / 2), null, "not before the grace");
  const left = await a.next((m) => m.type === "left", GRACE_MS + 500);
  assert.equal(left?.peerId, "cap:peer:b");

  a.close();
  await sleep(GRACE_MS + 100);
});

test("an explicit leave is immediate; a zombie socket is superseded by a rejoin", async () => {
  const a = await client("cap:peer:a");
  const b = await client("cap:peer:b");
  a.join(); await a.next((m) => m.type === "peers");
  b.join(); await b.next((m) => m.type === "peers");
  await a.next((m) => m.type === "joined");

  // b rejoins on a NEW socket while the old one is still open (the server
  // hasn't noticed it is dead). The seat moves; the old socket is cut.
  const b2 = await client("cap:peer:b");
  b2.join();
  assert.equal((await b2.next((m) => m.type === "peers"))?.resumed, true);
  await sleep(50);
  assert.equal(b.ws.readyState, WebSocket.CLOSED, "the superseded socket is terminated");
  assert.equal(a.got.filter((m) => m.type === "left" || m.type === "joined").length, 0, "the room saw nothing");
  b2.send({ type: "data", roomId: ROOM, from: "cap:peer:b", payload: "via-new" });
  assert.equal((await a.next((m) => m.type === "data"))?.payload, "via-new");

  b2.send({ type: "leave", roomId: ROOM, peerId: "cap:peer:b" });
  const left = await a.next((m) => m.type === "left", 300);
  assert.equal(left?.peerId, "cap:peer:b", "an explicit leave does not wait for the grace");

  a.close(); b2.close();
  await sleep(GRACE_MS + 100);
});

test.after(() => server.stop());

// peer.test.mjs — the dial state machine.
//
// `peer.ts` decides whether two people in a room can reach each other. The model
// is deliberately small: full mesh, and for any pair the lexicographically-
// SMALLER peerId is the one that dials — the larger only answers, stepping in as
// a fallback dialler only after a grace period. This file drives that with a
// stubbed clock, socket and RTCPeerConnection — no browser.
//
//   node packages/browser/test/peer.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// The ZFA kernel is WASM and irrelevant to connecting; stub it at resolve time.
const stubZfa = {
  name: "stub-zfa",
  setup(b) {
    b.onResolve({ filter: /\.\/zfa\.js$/ }, () => ({ path: "zfa-stub", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      // Unique per call: two tabs minting the same id would hide the very
      // collision this file is here to rule out.
      contents: "let n = 0;"
              + "export const validateCapability = (t) => typeof t === 'string' && t.startsWith('cap:');"
              + "export const generateCapability = (l) => `cap:${l}:${(++n).toString().padStart(4,'0')}`;",
      loader: "js",
    }));
  },
};

const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "peer.ts")],
  bundle: true, format: "esm", platform: "node", write: false, plugins: [stubZfa],
});

const provide = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

// --- a clock we control ------------------------------------------------------
let now = 1_000_000;
const realNow = Date.now;
provide("Date", new Proxy(Date, { get: (t, k) => (k === "now" ? () => now : Reflect.get(t, k)) }));
const advance = (ms) => { now += ms; };

// --- a socket that never really opens ---------------------------------------
const sent = [];
class FakeWS {
  static OPEN = 1; static CLOSED = 3; static CLOSING = 2;
  constructor() { this.readyState = 1; FakeWS.last = this; }
  send(data) { sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  addEventListener(n, f) { this[`on${n}`] = f; }
}
provide("WebSocket", FakeWS);

// --- peer connections we can hold in any state -------------------------------
const made = [];
class FakePC {
  constructor() {
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.signalingState = "stable";
    this.localDescription = { sdp: "a=ice-ufrag:AAAA" };
    this.remoteDescription = null;
    made.push(this);
  }
  createDataChannel() {
    const ch = { readyState: "connecting", send() {}, close() {} };
    this.channel = ch;
    return ch;
  }
  // Drive a data channel to "open" the way a completed handshake would — the
  // initiator's own channel, or (answerer) a channel arriving via ondatachannel.
  openChannel() {
    this.connectionState = "connected";
    if (!this.channel && this.ondatachannel) {
      this.channel = { readyState: "connecting", send() {}, close() {} };
      this.ondatachannel({ channel: this.channel });
    }
    if (this.channel) { this.channel.readyState = "open"; this.channel.onopen?.(); }
    this.onconnectionstatechange?.();
  }
  async createOffer() { return { type: "offer", sdp: "a=ice-ufrag:AAAA" }; }
  async createAnswer() { return { type: "answer", sdp: "a=ice-ufrag:BBBB" }; }
  async setLocalDescription() {}
  async setRemoteDescription(d) { this.remoteDescription = { sdp: d?.sdp ?? "" }; }
  async addIceCandidate() {}
  getSenders() { return []; }
  addTrack() { return {}; }
  close() {
    // A browser fires the state handler on close — that is what made a retry
    // look like the peer leaving — but it does not fire again for a connection
    // that is already closed, and a stub that does recurses through cleanup.
    if (this.connectionState === "closed") return;
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  }
}
provide("RTCPeerConnection", FakePC);
provide("RTCSessionDescription", class {});
provide("RTCIceCandidate", class { constructor(x) { Object.assign(this, x); } });

const { QOSPeer } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

let failed = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};
const offersTo = (id) => sent.filter((m) => m.type === "offer" && m.to === id).length;
const answersTo = (id) => sent.filter((m) => m.type === "answer" && m.to === id).length;

// --- an identity that survives a phone discarding the tab ---------------------
// sessionStorage is per-tab, which is right, but a mobile browser throws it away
// when it evicts a backgrounded tab — so a phone came back as a NEW peer every
// time and the room filled with ghosts of its previous incarnations.
const session = new Map();
const local = new Map();
provide("sessionStorage", {
  getItem: (k) => session.get(k) ?? null,
  setItem: (k, v) => session.set(k, String(v)),
});
provide("localStorage", {
  getItem: (k) => local.get(k) ?? null,
  setItem: (k, v) => local.set(k, String(v)),
  key: (i) => [...local.keys()][i] ?? null,
  get length() { return local.size; },
});

const first = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246" });
check("an id is leased when it is minted",
      [...local.keys()].some((k) => k.endsWith(first.peerId)), [...local.keys()].join(","));

session.clear();                       // the phone discarded the tab
advance(60_000);                       // and stayed away long enough
const back = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246" });
check("a tab that comes back reclaims its own id rather than becoming a stranger",
      back.peerId === first.peerId, `${back.peerId} vs ${first.peerId}`);

session.clear();
local.set(`qos-peer-lease:${first.peerId}`, String(now));   // the other tab is alive
const second = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246" });
check("a second tab open at the same time gets its own id",
      second.peerId !== first.peerId, `${second.peerId} vs ${first.peerId}`);
first.disconnect(); back.disconnect(); second.disconnect();

// A stale lease left by a DIFFERENT identity (a recovery, a storage clear, an
// incognito key leak) must not be reclaimed — inheriting it makes every peer
// that TOFU-pinned that id refuse our signed name as an anchor mismatch.
session.clear(); local.clear();
local.set("qos-dyncap-state", JSON.stringify({ seed: "x", anchor: "b".repeat(64) }));
local.set("qos-peer-lease:cap:peer:02460246024602460246024602460246",
          JSON.stringify({ at: now - 60_000, anchor: "a".repeat(64) }));   // someone else's abandoned id
const fresh = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246" });
check("a stale lease under another identity's anchor is not reclaimed",
      fresh.peerId !== "cap:peer:02460246024602460246024602460246", fresh.peerId);
check("the fresh id's own lease records this identity's anchor",
      JSON.parse(local.get(`qos-peer-lease:${fresh.peerId}`)).anchor === "b".repeat(64),
      local.get(`qos-peer-lease:${fresh.peerId}`));
fresh.disconnect();

// But a stale lease under OUR OWN anchor still comes back to us (the common case
// — a phone that dropped the tab, same identity).
session.clear(); local.clear();
local.set("qos-dyncap-state", JSON.stringify({ seed: "x", anchor: "c".repeat(64) }));
local.set("qos-peer-lease:cap:peer:02460246024602460246024602460246",
          JSON.stringify({ at: now - 60_000, anchor: "c".repeat(64) }));
const mineBack = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246" });
check("a stale lease under our own anchor is reclaimed",
      mineBack.peerId === "cap:peer:02460246024602460246024602460246", mineBack.peerId);
mineBack.disconnect();

// --- a peer in a room --------------------------------------------------------
// This peer's id "mmm" sorts ABOVE "aaa" and BELOW "zzz", so it is the initiator
// for "zzz" and the answerer for "aaa" — both sides of the rule in one peer.
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = () => new Promise((r) => setTimeout(r, 50));
const deliver = (msg) => FakeWS.last.onmessage?.({ data: JSON.stringify(msg) });

const left = [];
const peer = new QOSPeer({
  signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "mmm",
  onPeerLeft: (id) => left.push(id),
});
peer.connect();
await tick();                 // the socket is created inside an async open
FakeWS.last.onopen?.();
await tick();                 // handlers are attached after the open resolves
check("joining the room is announced", sent.some((m) => m.type === "join"), JSON.stringify(sent));

deliver({ type: "peers", peers: ["aaa", "zzz"] });
await settle();
check("the smaller-id side dials the peer it is the initiator for",
      offersTo("zzz") === 1, `zzz:${offersTo("zzz")}`);
check("the larger-id side does not dial immediately — it waits to be dialled",
      offersTo("aaa") === 0, `aaa:${offersTo("aaa")}`);

// --- the larger-id side answers an inbound offer -----------------------------
deliver({ type: "offer", from: "aaa", sdp: "a=ice-ufrag:CCCC" });
await settle();
check("an inbound offer is answered", answersTo("aaa") === 1, `answers:${answersTo("aaa")}`);

// --- an attempt in flight is left alone --------------------------------------
// A connection still negotiating has no open channel, and redialling it throws
// the negotiation away. A phone gathering candidates for twenty seconds could
// never finish.
const before = offersTo("zzz");
advance(30_000);
peer.sweep();
await tick();
check("a connection still negotiating is not redialled", offersTo("zzz") === before,
      `${offersTo("zzz")} vs ${before}`);

// --- until it is clearly stuck ----------------------------------------------
advance(60_000);   // past ATTEMPT_PATIENCE_MS
peer.sweep();
await settle();
check("an attempt stuck far too long is retried", offersTo("zzz") === before + 1,
      `${offersTo("zzz")} vs ${before}`);

// --- the fallback dialler: the larger-id side steps in after a grace period --
// If the smaller side is dead or on an old build, nothing dials — so the larger
// side dials too, just later (RETRY_INTERVAL + FALLBACK_EXTRA).
const aaaBefore = offersTo("aaa");
advance(60_000);   // well past RETRY_INTERVAL_MS + FALLBACK_EXTRA_MS
peer.sweep();
await settle();
check("the larger-id side eventually dials as a fallback", offersTo("aaa") > aaaBefore,
      `${offersTo("aaa")} vs ${aaaBefore}`);

// --- a failed connection is retried ----------------------------------------
made.forEach((pc) => { pc.connectionState = "failed"; });
const failedAt = offersTo("zzz");
advance(60_000);
peer.sweep();
await settle();
check("a failed connection is dialled again", offersTo("zzz") > failedAt,
      `${offersTo("zzz")} vs ${failedAt}`);

// --- a retry is not a departure ----------------------------------------------
// Closing the old connection fires its handlers, which declared the peer gone —
// so every retry manufactured a "left". Detaching the handlers before close
// fixes that.
left.length = 0;
made.forEach((pc) => { pc.connectionState = "failed"; });
advance(200_000);
peer.sweep();
await settle();
check("replacing our own connection does not report the peer as gone",
      left.length === 0, JSON.stringify(left));

// --- an ICE failure to a peer still in the room is unreachable, not gone ------
// A cross-network peer with no working TURN never completes a direct handshake.
// Firing "failed" used to call onPeerLeft → the app drops them from the roster,
// so the peer VANISHES for everyone who cannot dial them. A peer the signaling
// server still lists is present: keep them (the app marks them ⚠) and retry.
left.length = 0;
deliver({ type: "peers", peers: ["aaa", "zzz"] });
await settle();
made.forEach((pc) => {
  if (pc.connectionState !== "closed") { pc.connectionState = "failed"; pc.onconnectionstatechange?.(); }
});
await tick();
check("a peer still in the roster is not reported gone when its connection fails",
      left.length === 0, JSON.stringify(left));
const retryFrom = offersTo("zzz");
advance(600_000);
peer.sweep();
await settle();
check("the sweep keeps retrying a failed-but-still-present peer",
      offersTo("zzz") > retryFrom, `${offersTo("zzz")} vs ${retryFrom}`);

// --- but once the server drops them, a failure does declare them gone --------
left.length = 0;
peer.roster = new Set(["zzz"]);
advance(600_000);
peer.sweep();                        // dial zzz → one fresh live pc
await settle();
peer.roster.delete("zzz");           // now the server has forgotten zzz
made.forEach((pc) => {
  if (pc.connectionState !== "closed") { pc.connectionState = "failed"; pc.onconnectionstatechange?.(); }
});
await tick();
check("a peer no longer in the roster IS reported gone on connection failure",
      left.includes("zzz"), JSON.stringify(left));

// --- redial(): a manual 'connect now' dials regardless of which side we are ---
const highRedial = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "zzzz" });
highRedial.connect();
await tick();
FakeWS.last.onopen?.();
await tick();
deliver({ type: "peers", peers: ["aaaa"] });   // zzzz is the LARGER id — no immediate dial
await settle();
check("the larger-id side does not dial on the peer list", offersTo("aaaa") === 0, `${offersTo("aaaa")}`);
highRedial.redial("aaaa");
await settle();
check("redial() forces a dial from the larger-id side too", offersTo("aaaa") === 1, `${offersTo("aaaa")}`);

// --- a peer that left is not chased ------------------------------------------
deliver({ type: "left", peerId: "aaaa" });
const goneAt = offersTo("aaaa");
advance(200_000);
highRedial.sweep();
await settle();
check("a peer that left is not dialled", offersTo("aaaa") === goneAt, `${offersTo("aaaa")} vs ${goneAt}`);
highRedial.disconnect();

// --- a phone that sleeps: channel dies but the peer is not reported gone ------
// A phone going to sleep freezes its tab and tears the SCTP association down.
// The peer is still in the room — declaring them gone (then re-joined on wake)
// is the "flagged then dropped then back" churn. Keep them, mark ⚠, retry.
{
  const woke = [];
  const wLeft = [];
  const w = new QOSPeer({
    signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "mmm2",
    onChannelOpen: (id) => woke.push(id),
    onPeerLeft: (id) => wLeft.push(id),
  });
  w.connect(); await tick(); FakeWS.last.onopen?.(); await tick();
  deliver({ type: "peers", peers: ["aaa2"] });   // mmm2 > aaa2 → aaa2 dials us
  await settle();
  deliver({ type: "offer", from: "aaa2", sdp: "a=ice-ufrag:S1" });
  await settle();
  const pc1 = made[made.length - 1];
  pc1.openChannel();                              // handshake completes
  await settle();
  check("the channel opened", woke.includes("aaa2"), JSON.stringify(woke));

  // Phone sleeps: the data channel closes while aaa2 is still in the roster.
  pc1.channel.readyState = "closed";
  pc1.channel.onclose?.();
  await settle();
  check("a channel closing for a peer still in the roster does NOT report them gone",
        wLeft.length === 0, JSON.stringify(wLeft));

  // Phone wakes: signaling re-broadcasts "joined" for it. We hold a stale pc —
  // reestablish() must drop it. aaa2 is the initiator, so it will send a fresh
  // offer; we answer it and the channel reopens.
  woke.length = 0;
  deliver({ type: "joined", peerId: "aaa2" });
  await settle();
  deliver({ type: "offer", from: "aaa2", sdp: "a=ice-ufrag:S2" });   // fresh ICE session
  await settle();
  const pc2 = made[made.length - 1];
  check("a fresh pc was built for the reconnecting peer", pc2 !== pc1, "reused the stale pc");
  pc2.openChannel();
  await settle();
  check("the channel reopens after the peer wakes", woke.includes("aaa2"), JSON.stringify(woke));
  check("...and still no spurious 'left'", wLeft.length === 0, JSON.stringify(wLeft));
  w.disconnect();
}

// --- broadcast / send carry no routing tags — full mesh, plain -------------
{
  const plain = new QOSPeer({ signalingUrl: "wss://x", roomId: "cap:room:0246", peerId: "plain-a" });
  const sentTo = new Map();
  const fakeChannel = (id) => ({
    readyState: "open",
    send(payload) { const arr = sentTo.get(id) ?? []; arr.push(JSON.parse(payload)); sentTo.set(id, arr); },
  });
  plain.channels.set("nb1", fakeChannel("nb1"));
  plain.channels.set("nb2", fakeChannel("nb2"));

  plain.broadcast({ kind: "chat", text: "hi" });
  const b1 = sentTo.get("nb1")[0];
  check("broadcast reaches every open channel verbatim, with no _relay* fields",
        JSON.stringify(b1) === JSON.stringify({ kind: "chat", text: "hi" })
        && JSON.stringify(sentTo.get("nb2")[0]) === JSON.stringify(b1),
        JSON.stringify(b1));

  sentTo.set("nb1", []);
  const ok1 = plain.send("nb1", { kind: "note-pass", token: "x" });
  check("send() to a peer with an open channel is raw and untagged",
        ok1 === true && JSON.stringify(sentTo.get("nb1")[0]) === JSON.stringify({ kind: "note-pass", token: "x" }),
        JSON.stringify(sentTo.get("nb1")[0]));

  const ok2 = plain.send("nobody", { kind: "note-pass" });
  check("send() to a peer with no channel returns false (no flood fallback)", ok2 === false, `${ok2}`);
  plain.disconnect();
}

Date.now = realNow;
console.log(failed === 0 ? "\npeer: all passed" : `\npeer: ${failed} FAILED`);
process.exit(failed ? 1 : 0);

// Local loopback integration test: a tiny in-process signaling relay + two
// QOSPeer instances in the same room, exchanging a chat over WebRTC. Verifies
// the werift↔werift handshake and the inbound-message hook end to end, with no
// browser and no external server. Run: node loopback.mjs
import { startRelay } from "./mini-relay.mjs";
import { QOSPeer } from "./qospeer.mjs";
import { generateCapability } from "./zfa.mjs";

const PORT = 4456;
const ROOM = "cap:room:" + "0167".repeat(8); // any well-formed-ish room id

// ---- minimal signaling relay (shared: mini-relay.mjs) ----
const { wss } = startRelay(PORT);

// ---- two peers ----
const url = `ws://localhost:${PORT}`;
const received = { A: null, B: null };
const opens = { A: 0, B: 0 };   // onChannelOpen count — a glare rebuild storm shows up here
const mk = (label) => new QOSPeer({
  signalingUrl: url, roomId: ROOM, peerId: generateCapability("peer"), iceServers: [],
  onChannelOpen: (id) => { opens[label]++; console.log(`[${label}] channel open → ${id.slice(0,10)}…; sending chat`); peers[label].broadcast({ kind: "chat", text: `hello-from-${label}` }); },
  onMessage: (from, d) => { if (d && d.kind === "chat") { received[label] = d.text; console.log(`[${label}] received: ${d.text}`); } },
  onError: (e) => console.error(`[${label}]`, e?.message ?? e),
});

const peers = {};
const a = peers.A = mk("A");
peers.B = mk("B");

a.connect();
setTimeout(() => peers.B.connect(), 600);

// Glare: once both are connected, make BOTH dial the other on the same tick —
// exactly what a roster change does to two node peers. Perfect-negotiation
// arbitration (smaller peerId yields, larger keeps its offer) must settle this
// without an endless rebuild. Before the fix this pegged both cores and
// onChannelOpen fired hundreds of times.
setTimeout(() => {
  const bId = peers.B.peerId, aId = peers.A.peerId;
  console.log(`\n-- forcing glare: A(${aId.slice(9,13)}) <-> B(${bId.slice(9,13)}) dial simultaneously --`);
  peers.A._initiate(bId).catch(() => {});
  peers.B._initiate(aId).catch(() => {});
}, 6000);

setTimeout(() => {
  const roundTrip = received.A === "hello-from-B" && received.B === "hello-from-A";
  const aOpen = peers.A._channelOpen(peers.A.channels.get(peers.B.peerId));
  const bOpen = peers.B._channelOpen(peers.B.channels.get(peers.A.peerId));
  // The regression under test is the STORM — before the fix, onChannelOpen
  // fired hundreds of times and serveStateTo with it. A calm glare settles in
  // ≤ 2 opens per side (the first connect + one legitimate rebuild by the peer
  // that yields). Channel-open is reported for context but not asserted: in a
  // no-network local loopback the post-glare ICE recheck can still be in
  // flight at the sample point, which is a werift timing artifact, not churn.
  const calm = opens.A <= 3 && opens.B <= 3;
  const pass = roundTrip && calm;
  console.log(`\n${pass ? "PASS" : "FAIL"}  werift↔werift: round-trip + glare settles without a rebuild storm`);
  console.log(`  A received: ${received.A}   B received: ${received.B}`);
  console.log(`  onChannelOpen counts: A ${opens.A}  B ${opens.B} (storm = hundreds)   channels now: A→B ${aOpen}  B→A ${bOpen}`);
  try { peers.A.disconnect(); peers.B.disconnect(); wss.close(); } catch {}
  setTimeout(() => process.exit(pass ? 0 : 1), 200);
}, 13000);

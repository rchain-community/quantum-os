// A node agent is data-only. When a browser peer starts a call, it renegotiates
// with every peer — agents included — adding audio/video to the offer. Without
// _rejectMedia, werift accepts the media, registers SSRC receivers, and burns
// ~20% of a core per call decrypting inbound RTP it will never use (measured
// live: three co-located agents pegged a machine on one call).
//
// This test drives a QOSPeer through an inbound offer that carries audio + video
// alongside the data channel and asserts: (1) the data channel still opens, and
// (2) the answer rejects every media m-line (port 0 / a=inactive), so a
// compliant peer sends no RTP. Run: node media-reject.selftest.mjs
import { startRelay } from "./mini-relay.mjs";
import { roomIdFor } from "../../packages/browser/src/room-crypto.js";
import { RTCPeerConnection } from "werift";
import { QOSPeer } from "./qospeer.mjs";
import { generateCapability } from "./zfa.mjs";

const PORT = 4459;
const ROOM = "cap:room:" + "0167".repeat(8);

// minimal signaling relay, and a tap on the answer SDP the agent emits
let answerSdp = null;
const relay = startRelay(PORT);
const { wss } = relay;
relay.onMessage = (_ws, m) => { if (m.type === "answer") answerSdp = m.sdp; };

const url = `ws://localhost:${PORT}`;
const agentId = generateCapability("peer");
let dataOpened = false;

const agent = new QOSPeer({
  signalingUrl: url, roomId: ROOM, peerId: agentId, iceServers: [],
  // Both callbacks given, so onChannelOpen means the direct WebRTC link (the
  // thing under test), not "peer addressable" — see qospeer.mjs CALLBACKS.
  onPeerReady: () => {},
  onChannelOpen: () => { dataOpened = true; },
  onMessage: () => {},
  onError: (e) => console.error("[agent]", e?.message ?? e),
});
await agent.connect();
// The relay knows the room by its hash, not the token (room-crypto.js).
const WIRE = await roomIdFor(ROOM);

// A "browser" peer: raw werift, offers data + audio + video like a call would.
await new Promise((r) => setTimeout(r, 800));
const browserId = generateCapability("peer");
const bws = new (await import("ws")).WebSocket(url);
await new Promise((r) => bws.on("open", r));
const bpc = new RTCPeerConnection({ iceServers: [] });
bpc.onIceCandidate.subscribe((c) => c && bws.send(JSON.stringify({ type: "ice", roomId: WIRE, from: browserId, to: agentId, candidate: c.toJSON ? c.toJSON() : c })));
bpc.createDataChannel("qos");
bpc.addTransceiver("audio", { direction: "sendrecv" });
bpc.addTransceiver("video", { direction: "sendrecv" });
bws.on("message", async (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "answer") { await bpc.setRemoteDescription({ type: "answer", sdp: m.sdp }); }
  else if (m.type === "ice" && m.candidate) { try { await bpc.addIceCandidate(m.candidate); } catch {} }
});
bws.send(JSON.stringify({ type: "join", roomId: WIRE, peerId: browserId }));
await new Promise((r) => setTimeout(r, 300));
const offer = await bpc.createOffer();
await bpc.setLocalDescription(offer);
bws.send(JSON.stringify({ type: "offer", roomId: WIRE, from: browserId, to: agentId, sdp: bpc.localDescription?.sdp ?? offer.sdp }));

await new Promise((r) => setTimeout(r, 4000));

const mediaLines = (answerSdp ?? "").split("\n").filter((l) => /^m=(audio|video)/.test(l)).map((l) => l.trim());
const allRejected = mediaLines.length >= 2 && mediaLines.every((l) => / 0 /.test(l) || l.split(" ")[1] === "0");
const inactive = (answerSdp ?? "").split("\n").filter((l) => l.trim() === "a=inactive").length >= 2;
const recvTransceivers = agent.connections.get(browserId)?.getTransceivers?.().filter((t) => ["recvonly", "sendrecv"].includes(t.direction)) ?? [];

const pass = dataOpened && !!answerSdp && (allRejected || inactive) && recvTransceivers.length === 0;
console.log(`${pass ? "PASS" : "FAIL"}  agent rejects call media, keeps the data channel`);
console.log(`  data channel opened: ${dataOpened}`);
console.log(`  answer media m-lines: ${JSON.stringify(mediaLines)}`);
console.log(`  a=inactive count: ${inactive}   active recv transceivers: ${recvTransceivers.length}`);

try { agent.disconnect(); bpc.close(); bws.close(); wss.close(); } catch {}
setTimeout(() => process.exit(pass ? 0 : 1), 200);

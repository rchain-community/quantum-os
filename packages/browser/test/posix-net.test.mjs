// posix-net.test.mjs — the POSIX-style socket macro layer (docs/connection.md
// "posix-net"): connect/listen/accept/send/close framing and multiplexing,
// exercised against a fake two-peer mesh. posix-net.ts is dependency-free
// (it only ever talks to the SocketTransport interface, never WebRTC
// directly), so this needs no browser and no QOSPeer — just two instances
// wired to each other.
//
//   node packages/browser/test/posix-net.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "posix-net.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
});
const { PosixNet } =
  await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};

// --- a fake two-peer mesh: no WebRTC, just two SocketTransport stubs -------
// wired directly to each other's PosixNet.onTransportMessage. Delivery is
// synchronous, which is fine here — posix-net.ts does no I/O of its own, so
// nothing depends on message delivery being async.
class FakeTransport {
  constructor(selfId) {
    this.selfId = selfId;
    this.open = { stream: false, dgram: false };
    this.peer = null;  // the other FakeTransport
    this.net = null;   // this transport's own PosixNet
    this.sent = [];     // every frame actually delivered, for assertions
  }
  pinNeighbor() { /* tests open channels explicitly; nothing to pin */ }
  hasSocketChannel(_peerId, type) { return this.open[type]; }
  sendSocketFrame(_peerId, type, data) {
    if (!this.open[type] || !this.peer.open[type]) return false;
    this.sent.push({ type, data });
    this.peer.net.onTransportMessage(this.selfId, type, data);
    return true;
  }
}

function link(idA, idB) {
  const a = new FakeTransport(idA);
  const b = new FakeTransport(idB);
  a.peer = b; b.peer = a;
  const netA = new PosixNet(a); a.net = netA;
  const netB = new PosixNet(b); b.net = netB;
  return { netA, netB, a, b };
}

/** Open a channel of `type` on both sides and flush any queued SYNs. */
function openChannel({ netA, netB, a, b }, type) {
  a.open[type] = true;
  b.open[type] = true;
  netA.onTransportChannelOpen(b.selfId, type);
  netB.onTransportChannelOpen(a.selfId, type);
}

// --- connect() queues until the channel opens, then completes the handshake
{
  const mesh = link("peer-a", "peer-b");
  const { netA, netB, a } = mesh;

  let accepted = null;
  netB.listen(7, "stream", (socket, fromPeerId) => { accepted = { socket, fromPeerId }; });

  const connectPromise = netA.connect("peer-b", 7, "stream");
  check("no SYN sent before the channel opens", a.sent.length === 0, JSON.stringify(a.sent));

  openChannel(mesh, "stream");
  const socketA = await connectPromise;

  check("accept() fired on the listening side", accepted !== null);
  check("accept() reports the true caller", accepted?.fromPeerId === "peer-a");
  check("both sides agree on the connection id", socketA.connId === accepted.socket.connId);
  check("socket type is stream", socketA.type === "stream" && accepted.socket.type === "stream");

  let received = null;
  accepted.socket.onData = (payload) => { received = payload; };
  socketA.send("hello");
  check("data delivered to the accepting side", received === "hello");

  let echoed = null;
  socketA.onData = (payload) => { echoed = payload; };
  accepted.socket.send("world");
  check("data delivered back to the connecting side", echoed === "world");

  let closedOnAccept = false;
  accepted.socket.onClose = () => { closedOnAccept = true; };
  socketA.close();
  check("close() on one side fires onClose on the other", closedOnAccept === true);

  const sentAfterClose = a.sent.length;
  socketA.close();
  check("closing twice sends only one FIN", a.sent.length === sentAfterClose);
}

// --- connecting to a port nobody is listening on is refused, not silent ---
{
  const mesh = link("x", "y");
  openChannel(mesh, "stream");
  let errMessage = null;
  try { await mesh.netA.connect("y", 99, "stream"); }
  catch (e) { errMessage = e.message; }
  check("connect to an unlistened port rejects", errMessage === "connection refused", errMessage);
}

// --- dgram sockets use the same framing/handshake over the dgram channel --
{
  const mesh = link("p", "q");
  let accepted = null;
  mesh.netB.listen(53, "dgram", (socket) => { accepted = socket; });
  const connectPromise = mesh.netA.connect("q", 53, "dgram");
  openChannel(mesh, "dgram");
  const socket = await connectPromise;
  check("dgram handshake completes", accepted !== null && socket.type === "dgram");

  let received = null;
  accepted.onData = (p) => { received = p; };
  socket.send("ping");
  check("dgram payload delivered", received === "ping");
  check("stream channel untouched by dgram traffic", mesh.a.sent.every((f) => f.type === "dgram"));
}

// --- PosixNet.close() rejects everything still pending, doesn't hang -----
{
  const mesh = link("m", "n");
  // Channel never opens, so the SYN never actually sends — connect() should
  // still be rejectable rather than left dangling forever.
  const pending = mesh.netA.connect("n", 1, "stream");
  mesh.netA.close();
  let errMessage = null;
  try { await pending; } catch (e) { errMessage = e.message; }
  check("close() rejects a still-pending connect", errMessage === "posix-net closed", errMessage);
}

// --- malformed / non-frame input on a socket channel is ignored, not thrown
{
  const mesh = link("g", "h");
  let threw = false;
  try {
    mesh.netB.onTransportMessage("g", "stream", "not json at all");
    mesh.netB.onTransportMessage("g", "stream", JSON.stringify({ hello: "world" }));
  } catch { threw = true; }
  check("garbage input on a socket channel never throws", threw === false);
}

console.log(failed === 0 ? "\nposix-net: all passed" : `\nposix-net: ${failed} FAILED`);
process.exit(failed ? 1 : 0);

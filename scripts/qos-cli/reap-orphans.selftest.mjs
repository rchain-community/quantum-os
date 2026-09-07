// Selftest for QOSPeer._reapOrphans — the backstop that closes a peer
// connection werift's missing consent timer would otherwise leave burning CPU.
// No network: fake pcs/channels, drive _reapOrphans directly.
//   node reap-orphans.selftest.mjs
import { QOSPeer } from "./qospeer.mjs";

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}`); if (!c) fail++; };

const p = new QOSPeer({ signalingUrl: "ws://x", roomId: "cap:room:0167".padEnd(41, "0"), peerId: "me" });
// pretend signaling is up so _reapOrphans runs
p.ws = { readyState: 1 };
const fakePc = () => { let closed = false; return { get closed() { return closed; }, close() { closed = true; } }; };

// 1. a connection to a peer no longer in the roster is reaped
const gone = fakePc();
p.connections.set("gone", gone);
p.roster = new Set(["me", "here"]);
p.connections.set("here", fakePc());
p.channels.set("here", { readyState: "open" });
p._reapOrphans();
ok(!p.connections.has("gone") && gone.closed, "a pc to a peer not in the roster is closed");
ok(p.connections.has("here"), "a pc to a peer still in the roster with an open channel is kept");

// 2. an empty roster (just reconnected, no `peers` yet) reaps nothing by roster
const p2 = new QOSPeer({ signalingUrl: "ws://x", roomId: "cap:room:0167".padEnd(41, "0"), peerId: "me" });
p2.ws = { readyState: 1 };
const keep = fakePc();
p2.connections.set("x", keep);
p2.channels.set("x", { readyState: "open" });
p2.roster = new Set();                    // empty
p2._reapOrphans();
ok(p2.connections.has("x") && !keep.closed, "an empty roster does not reap an otherwise-healthy connection");

// 3. a channel-less pc stuck far past a handshake is reaped even if still rostered
const p3 = new QOSPeer({ signalingUrl: "ws://x", roomId: "cap:room:0167".padEnd(41, "0"), peerId: "me" });
p3.ws = { readyState: 1 };
const stuck = fakePc();
p3.connections.set("slow", stuck);
p3.roster = new Set(["me", "slow"]);
p3.attemptAt.set("slow", Date.now() - 120_000);   // 2 min ago, never opened a channel
p3._reapOrphans();
ok(!p3.connections.has("slow") && stuck.closed, "a channel-less pc stuck >90s is reaped");

// 4. a recent channel-less pc (still handshaking) is left alone
const p4 = new QOSPeer({ signalingUrl: "ws://x", roomId: "cap:room:0167".padEnd(41, "0"), peerId: "me" });
p4.ws = { readyState: 1 };
const fresh = fakePc();
p4.connections.set("dialing", fresh);
p4.roster = new Set(["me", "dialing"]);
p4.attemptAt.set("dialing", Date.now() - 5_000);
p4._reapOrphans();
ok(p4.connections.has("dialing") && !fresh.closed, "a pc still handshaking (<90s) is left alone");

console.log(fail === 0 ? "\nreap-orphans: all passed" : `\nreap-orphans: ${fail} FAILED`);
process.exit(fail ? 1 : 0);

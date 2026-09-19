// A minimal in-process signaling relay for the offline tests (loopback,
// list-cmd/observer e2e, media-reject) — one copy instead of four.
//
// Speaks the real server's protocol (packages/signaling/src/server.ts):
// join/peers/joined/left, offer/answer/ice, leave, and the control-plane
// `data` frame (to one peer or the room, sender-authenticated). What it
// deliberately leaves out is the grace window and replay — a test that needs
// those runs the real server (packages/signaling/test/server.test.mjs).
//
//   import { startRelay } from "./mini-relay.mjs";
//   const relay = startRelay(PORT);        // relay.wss, relay.rooms, relay.close()
//   relay.onMessage = (ws, m) => { … };    // optional tap on every parsed frame
import { WebSocketServer } from "ws";

export function startRelay(port) {
  const rooms = new Map();           // roomId -> Map<peerId, ws>
  const wsPeer = new Map();          // ws -> { roomId, peerId }
  const wss = new WebSocketServer({ port });
  const send = (ws, m) => { try { ws.send(JSON.stringify(m)); } catch {} };
  const relay = { wss, rooms, wsPeer, onMessage: null, close: () => { try { wss.close(); } catch {} } };

  const leave = (ws) => {
    const info = wsPeer.get(ws); wsPeer.delete(ws);
    const room = info && rooms.get(info.roomId);
    if (!room || room.get(info.peerId) !== ws) return;
    room.delete(info.peerId);
    for (const pws of room.values()) send(pws, { type: "left", roomId: info.roomId, peerId: info.peerId });
  };

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      relay.onMessage?.(ws, m);
      if (m.type === "join") {
        const room = rooms.get(m.roomId) ?? new Map();
        rooms.set(m.roomId, room);
        const resumed = room.has(m.peerId);
        const stale = room.get(m.peerId);
        if (stale && stale !== ws) { wsPeer.delete(stale); try { stale.terminate(); } catch {} }
        wsPeer.set(ws, { roomId: m.roomId, peerId: m.peerId });
        const others = [...room.keys()].filter((id) => id !== m.peerId);
        room.set(m.peerId, ws);
        send(ws, { type: "peers", roomId: m.roomId, peers: others, resumed });
        if (!resumed) for (const [pid, pws] of room) if (pid !== m.peerId) send(pws, { type: "joined", roomId: m.roomId, peerId: m.peerId });
      } else if (m.type === "offer" || m.type === "answer" || m.type === "ice") {
        const tgt = rooms.get(m.roomId)?.get(m.to);
        if (tgt) send(tgt, m);
      } else if (m.type === "data") {
        const info = wsPeer.get(ws);
        if (!info || info.peerId !== m.from) { send(ws, { type: "error", message: "relay from mismatch" }); return; }
        const room = rooms.get(m.roomId);
        if (!room) return;
        if (m.to !== undefined) { const tgt = room.get(m.to); if (tgt) send(tgt, m); }
        else for (const [pid, pws] of room) if (pid !== m.from) send(pws, m);
      } else if (m.type === "leave") {
        leave(ws);
      }
    });
    ws.on("close", () => leave(ws));
  });
  return relay;
}

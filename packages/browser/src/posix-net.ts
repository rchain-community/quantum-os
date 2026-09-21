/**
 * posix-net.ts — POSIX-style socket macros over the quantum-os mesh.
 *
 * `socket()`/`connect()`/`send()`/`recv()`/`close()`/`listen()`/`accept()`,
 * addressed by `(peerId, port)`, riding QOSPeer's two dedicated socket
 * channels (see SocketChannelKind in peer.ts): "stream" is the ordered,
 * reliable channel (TCP-like), "dgram" is unordered with no retransmits
 * (UDP-like). Nothing here talks to WebRTC directly — see SocketTransport
 * below — so this file is dependency-free and its framing/multiplexing
 * logic is testable with a fake transport, no browser required.
 *
 * Scope, deliberately: `connect(peerId, port)` only ever reaches another
 * quantum-os mesh peer. There is no address space here for an arbitrary
 * external host — a browser peer cannot open one, and a native peer that
 * eventually could is a separate, later runtime (see docs/connection.md).
 *
 * Socket traffic never rides the chat "qos" channel's flood/broadcast relay
 * (peer.ts's ringSkipNeighbors/broadcast/send) — every socket needs its
 * target peer pinned directly (SocketTransport.pinNeighbor), and a send
 * with no open channel simply fails rather than flooding the room with
 * point-to-point bytes nobody else should see.
 */

export type SocketType = "stream" | "dgram";

type Flag = "syn" | "syn-ack" | "data" | "fin" | "rst";

interface Frame {
  port: number;
  connId: string;
  seq: number;
  flag: Flag;
  payload?: string;
}

function encodeFrame(f: Frame): string {
  return JSON.stringify(f);
}

/** Rejects anything that isn't a well-formed frame — including an ordinary
 *  chat message that happened to arrive on a socket channel, which should
 *  never happen given the channels are dedicated, but costs nothing to guard. */
function decodeFrame(raw: string): Frame | null {
  let f: unknown;
  try { f = JSON.parse(raw); } catch { return null; }
  if (
    f && typeof f === "object" &&
    typeof (f as Frame).port === "number" &&
    typeof (f as Frame).connId === "string" &&
    typeof (f as Frame).seq === "number" &&
    typeof (f as Frame).flag === "string"
  ) {
    return f as Frame;
  }
  return null;
}

function listenerKey(type: SocketType, port: number): string {
  return `${type}:${port}`;
}

/**
 * The subset of QOSPeer that posix-net needs, injected rather than imported
 * directly — keeps this module's framing/multiplexing logic testable
 * against a fake mesh of two instances, with no RTCPeerConnection involved.
 */
export interface SocketTransport {
  readonly selfId: string;
  /** Force a direct link to this peer regardless of ring/skip position — a
   *  socket is point-to-point by definition, so it can't rely on ambient
   *  overlay connectivity the way chat can. */
  pinNeighbor(peerId: string): void;
  hasSocketChannel(peerId: string, type: SocketType): boolean;
  /** Returns false (rather than flooding) if no direct channel is open. */
  sendSocketFrame(peerId: string, type: SocketType, data: string): boolean;
}

export interface QosSocket {
  readonly connId: string;
  readonly peerId: string;
  readonly type: SocketType;
  readonly port: number;
  send(payload: string): boolean;
  close(): void;
  onData: ((payload: string) => void) | null;
  onClose: (() => void) | null;
}

interface PendingConnect {
  peerId: string;
  port: number;
  type: SocketType;
  resolve: (socket: QosSocket) => void;
  reject: (err: Error) => void;
}

/**
 * One posix-net endpoint. An app wires QOSPeer's `onSocketChannelOpen`/
 * `onSocketMessage` callbacks to `onTransportChannelOpen`/`onTransportMessage`
 * below — this class never touches QOSPeer itself, only the SocketTransport
 * interface, so those callbacks are the only integration point.
 */
export class PosixNet {
  private transport: SocketTransport;
  private sockets = new Map<string, QosSocket>();
  private listeners = new Map<string, (socket: QosSocket, fromPeerId: string) => void>();
  private pendingConnects = new Map<string, PendingConnect>();
  private counter = 0;

  constructor(transport: SocketTransport) {
    this.transport = transport;
  }

  /**
   * Open a socket to another mesh peer's port. Pins the peer directly (a
   * socket cannot rely on the bounded-degree overlay putting them within
   * reach) and sends the SYN once that peer's socket channel is actually
   * open — which may not be immediate, so this both fires the pin now and
   * queues the SYN for `onTransportChannelOpen` to flush once it lands.
   */
  connect(peerId: string, port: number, type: SocketType = "stream"): Promise<QosSocket> {
    this.transport.pinNeighbor(peerId);
    const connId = `${this.transport.selfId}:${this.counter++}`;
    return new Promise<QosSocket>((resolve, reject) => {
      this.pendingConnects.set(connId, { peerId, port, type, resolve, reject });
      this.trySendSyn(connId);
    });
  }

  private trySendSyn(connId: string): void {
    const p = this.pendingConnects.get(connId);
    if (!p) return;
    if (!this.transport.hasSocketChannel(p.peerId, p.type)) return; // flushed on channel open
    this.transport.sendSocketFrame(p.peerId, p.type, encodeFrame({ port: p.port, connId, seq: 0, flag: "syn" }));
  }

  /**
   * Listen for inbound connections on a port. Only one listener per
   * (type, port) — a second `listen()` on the same pair replaces the first,
   * same first-write-wins-by-registration shape as the rest of quantum-os's
   * per-key stores. Returns an unlisten function.
   */
  listen(port: number, type: SocketType, onAccept: (socket: QosSocket, fromPeerId: string) => void): () => void {
    const key = listenerKey(type, port);
    this.listeners.set(key, onAccept);
    return () => { this.listeners.delete(key); };
  }

  /** Wire this to QOSPeer's `onSocketChannelOpen` config callback. */
  onTransportChannelOpen(peerId: string, type: SocketType): void {
    for (const [connId, p] of this.pendingConnects) {
      if (p.peerId === peerId && p.type === type) this.trySendSyn(connId);
    }
  }

  /** Wire this to QOSPeer's `onSocketMessage` config callback. */
  onTransportMessage(peerId: string, type: SocketType, raw: string): void {
    const frame = decodeFrame(raw);
    if (!frame) return;

    switch (frame.flag) {
      case "syn": {
        const onAccept = this.listeners.get(listenerKey(type, frame.port));
        if (!onAccept) {
          this.transport.sendSocketFrame(
            peerId, type,
            encodeFrame({ port: frame.port, connId: frame.connId, seq: 0, flag: "rst" }),
          );
          return;
        }
        const socket = this.makeSocket(frame.connId, peerId, type, frame.port);
        this.sockets.set(frame.connId, socket);
        this.transport.sendSocketFrame(
          peerId, type,
          encodeFrame({ port: frame.port, connId: frame.connId, seq: 0, flag: "syn-ack" }),
        );
        onAccept(socket, peerId);
        return;
      }
      case "syn-ack": {
        const pending = this.pendingConnects.get(frame.connId);
        if (!pending) return;   // stray/duplicate — nothing waiting on it
        this.pendingConnects.delete(frame.connId);
        const socket = this.makeSocket(frame.connId, pending.peerId, pending.type, pending.port);
        this.sockets.set(frame.connId, socket);
        pending.resolve(socket);
        return;
      }
      case "data": {
        this.sockets.get(frame.connId)?.onData?.(frame.payload ?? "");
        return;
      }
      case "fin":
      case "rst": {
        const socket = this.sockets.get(frame.connId);
        this.sockets.delete(frame.connId);
        socket?.onClose?.();
        const pending = this.pendingConnects.get(frame.connId);
        if (pending) {
          this.pendingConnects.delete(frame.connId);
          pending.reject(new Error(frame.flag === "rst" ? "connection refused" : "connection closed"));
        }
        return;
      }
    }
  }

  private makeSocket(connId: string, peerId: string, type: SocketType, port: number): QosSocket {
    let seq = 1;   // 0 was the syn/syn-ack
    const socket: QosSocket = {
      connId, peerId, type, port,
      onData: null,
      onClose: null,
      send: (payload: string) =>
        this.transport.sendSocketFrame(peerId, type, encodeFrame({ port, connId, seq: seq++, flag: "data", payload })),
      close: () => {
        if (!this.sockets.delete(connId)) return;   // already closed
        this.transport.sendSocketFrame(peerId, type, encodeFrame({ port, connId, seq: seq++, flag: "fin" }));
      },
    };
    return socket;
  }

  /** Tear down every socket and listener — a room/peer disconnect. */
  close(): void {
    for (const socket of this.sockets.values()) socket.onClose?.();
    this.sockets.clear();
    this.listeners.clear();
    for (const p of this.pendingConnects.values()) p.reject(new Error("posix-net closed"));
    this.pendingConnects.clear();
  }
}

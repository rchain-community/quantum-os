import type WebSocket from "ws";

export interface Peer {
  id: string;         // ZFA capability token (hex-encoded)
  /** The live socket, or null while the peer is grace-held (socket lost, session kept). */
  ws: WebSocket | null;
  joinedAt: number;
  /** Armed while grace-held; fires the real departure. */
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** Control-plane payloads that arrived while grace-held, replayed on resume. */
  queue: string[];
  queuedBytes: number;
}

/**
 * How much a grace-held peer may have waiting for it. A phone that switched
 * apps for a minute comes back to the chat it missed; a peer that is gone for
 * good is reaped by the grace timer before this fills. Oldest dropped first —
 * the tail of a conversation is worth more than its head to someone returning.
 */
export const QUEUE_MAX_MSGS = 256;
export const QUEUE_MAX_BYTES = 512 * 1024;

/// A room groups peers that want to connect to each other.
/// Room IDs are what the peers call the room — since the resume/relay build
/// that is a hash of the ZFA capability token, so holding the id is not the
/// capability to join: the token stays with the peers.
export class Room {
  readonly id: string;
  private peers = new Map<string, Peer>();

  constructor(id: string) {
    this.id = id;
  }

  add(peer: Peer): void {
    this.peers.set(peer.id, peer);
  }

  get(peerId: string): Peer | undefined {
    return this.peers.get(peerId);
  }

  remove(peerId: string): void {
    const p = this.peers.get(peerId);
    if (p?.graceTimer) clearTimeout(p.graceTimer);
    this.peers.delete(peerId);
  }

  get size(): number {
    return this.peers.size;
  }

  get isEmpty(): boolean {
    return this.peers.size === 0;
  }

  /// Forward a message to a specific peer. Handshake traffic (offer/answer/ice)
  /// is only meaningful live; control-plane `data` is queued for a grace-held
  /// peer so a blip loses nothing.
  send(targetId: string, msg: unknown, queueIfHeld = false): boolean {
    const peer = this.peers.get(targetId);
    if (!peer) return false;
    const payload = JSON.stringify(msg);
    return this.deliver(peer, payload, queueIfHeld);
  }

  /// Broadcast to all peers except the sender.
  broadcast(senderId: string, msg: unknown, queueIfHeld = false): void {
    const payload = JSON.stringify(msg);
    for (const [id, peer] of this.peers) {
      if (id !== senderId) this.deliver(peer, payload, queueIfHeld);
    }
  }

  private deliver(peer: Peer, payload: string, queueIfHeld: boolean): boolean {
    if (peer.ws && peer.ws.readyState === 1 /* OPEN */) {
      peer.ws.send(payload);
      return true;
    }
    if (!queueIfHeld || peer.ws) return false;
    peer.queue.push(payload);
    peer.queuedBytes += payload.length;
    while (peer.queue.length > QUEUE_MAX_MSGS || peer.queuedBytes > QUEUE_MAX_BYTES) {
      const dropped = peer.queue.shift();
      peer.queuedBytes -= dropped?.length ?? 0;
    }
    return true;
  }

  /// Replay what was queued while the peer was grace-held, oldest first.
  flush(peer: Peer): number {
    const n = peer.queue.length;
    if (peer.ws && peer.ws.readyState === 1) {
      for (const payload of peer.queue) peer.ws.send(payload);
    }
    peer.queue = [];
    peer.queuedBytes = 0;
    return n;
  }

  peerIds(): string[] {
    return [...this.peers.keys()];
  }
}

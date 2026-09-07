import { generateCapability, validateCapability } from "./zfa.js";

type SignalMsg =
  | { type: "peers";   roomId: string; peers: string[] }
  | { type: "joined";  roomId: string; peerId: string }
  | { type: "left";    roomId: string; peerId: string }
  | { type: "offer";   roomId: string; from: string; to: string; sdp: string }
  | { type: "answer";  roomId: string; from: string; to: string; sdp: string }
  | { type: "ice";     roomId: string; from: string; to: string; candidate: RTCIceCandidateInit }
  | { type: "error";   message: string };

export interface PeerConfig {
  signalingUrl: string;    // ws://localhost:4444
  roomId: string;          // ZFA capability token identifying the room
  iceServers?: RTCIceServer[];
  /** Override the leased identity. Tests use it; the app never does. */
  peerId?: string;
  onSignalingOpen?: () => void;                       // fires on every successful WS connect
  onSignalingClose?: () => void;                      // fires when WS drops (before retry)
  onSignalingError?: (message: string) => void;       // the server refused something
  onMessage?: (from: string, data: unknown) => void;
  onPeerJoined?: (peerId: string) => void;
  onPeerLeft?: (peerId: string) => void;
  onChannelOpen?: (peerId: string) => void;
  onRemoteTrack?: (peerId: string, stream: MediaStream) => void;   // live-call media
}

/**
 * STUN alone — this file's own fallback when nobody hands it `iceServers`.
 *
 * STUN only tells each side what its public address looks like; the connection
 * is still made directly. Two peers behind symmetric NAT — a corporate network,
 * a mobile carrier doing CGNAT, a NAT'd container — have no address pair that
 * works, so the handshake fails permanently and retrying cannot help. That case
 * needs a TURN relay, which the app (`app.ts` `fetchAutoTurn`) supplies by
 * default: a short-lived Cloudflare-minted credential fetched from the
 * signaling server's own `GET /turn`, merged into `iceServers` before
 * `connect()`. `/ice auto off` opts out, `/ice turn ...` substitutes your own.
 */
export const DEFAULT_ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

// The ICE username fragment identifies an ICE session; a peer that reconnects (or
// reloads its browser, keeping its peerId) dials in with a new one. Used to tell a
// genuine same-session renegotiation from a reconnect under the same peerId. Null
// if the sdp has none.
function iceUfrag(sdp: string | null | undefined): string | null {
  const m = /a=ice-ufrag:(\S+)/.exec(sdp ?? "");
  return m ? m[1] : null;
}

/** Key holding "a tab is currently using this id", refreshed while it lives. */
const LEASE = "qos-peer-lease:";
const LEASE_TICK_MS = 5_000;
/** How long without a refresh before an id counts as abandoned. */
const LEASE_STALE_MS = 20_000;

/** This browser's dyncap anchor, read straight from the persisted state
 *  (`qos-dyncap-state`, written by app.ts) so peer.ts needn't import dyncap.ts.
 *  Null before the identity exists (very first launch) or if storage is off. */
function myAnchor(): string | null {
  try {
    const raw = localStorage.getItem("qos-dyncap-state");
    if (!raw) return null;
    const a = (JSON.parse(raw) as { anchor?: unknown }).anchor;
    return typeof a === "string" && a.length === 64 ? a : null;
  } catch { return null; }
}

/** A lease records WHO holds the id, not just when it was last seen: a bare
 *  timestamp is legacy (pre-anchor-scoping) and read as anchorless. */
function readLease(raw: string | null): { at: number; anchor: string | null } {
  if (!raw) return { at: 0, anchor: null };
  try {
    const o = JSON.parse(raw) as { at?: unknown; anchor?: unknown };
    if (o && typeof o.at === "number") return { at: o.at, anchor: typeof o.anchor === "string" ? o.anchor : null };
  } catch { /* legacy bare number */ }
  return { at: Number(raw) || 0, anchor: null };
}

/**
 * An identity that survives a phone discarding the tab.
 *
 * It used to live in sessionStorage alone, which is per-tab (right — two tabs
 * must differ) but which a mobile browser throws away when it evicts a
 * backgrounded tab. So a phone whose screen locked came back as a NEW peer every
 * time, filling the room with unreachable ghosts of its previous incarnations.
 *
 * So an id is leased: a live tab keeps saying it is using its id; a tab that
 * goes away stops, and the next load reclaims the abandoned id rather than
 * minting another — but only a lease left by this same dyncap anchor (a
 * different anchor's id is a prior occupant of a recycled id: taking it means
 * every peer that TOFU-pinned that id refuses our signed envelopes).
 */
function claimPeerId(): string {
  try {
    const mine = sessionStorage.getItem("qos-peer-id");
    if (mine && validateCapability(mine)) { touchLease(mine); return mine; }
  } catch { /* storage unavailable */ }

  const anchor = myAnchor();
  let reclaimed: string | null = null;
  try {
    const now = Date.now();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(LEASE)) continue;
      const id = key.slice(LEASE.length);
      if (!validateCapability(id)) continue;
      const lease = readLease(localStorage.getItem(key));
      if (now - lease.at <= LEASE_STALE_MS) continue;                 // still held
      if (lease.anchor && anchor && lease.anchor !== anchor) continue; // a different identity's id
      reclaimed = id; break;
    }
  } catch { /* ignore */ }

  const id = reclaimed ?? generateCapability("peer");
  try { sessionStorage.setItem("qos-peer-id", id); } catch { /* ignore */ }
  touchLease(id);
  return id;
}

function touchLease(id: string): void {
  try { localStorage.setItem(LEASE + id, JSON.stringify({ at: Date.now(), anchor: myAnchor() })); } catch { /* ignore */ }
}

/**
 * A QuantumOS browser peer — full mesh over an untrusted signaling relay.
 *
 * Every browser opens a data channel to every other browser in the room. For
 * any pair, the peer with the lexicographically-SMALLER id is the one that
 * dials; the larger only answers. Because only one side ever sends an offer for
 * establishment, there is no glare to arbitrate. The larger side steps in as a
 * fallback dialler only if a peer has sat unconnected for a while (a dead or
 * old-build smaller peer). Media renegotiation is the one path where either
 * side may offer, so a standard perfect-negotiation collision guard is kept for
 * that alone.
 *
 * Identity is a ZFA capability token — possessing the peer ID IS authorization.
 */
export class QOSPeer {
  readonly peerId: string;
  private ws: WebSocket | null = null;
  private connections = new Map<string, RTCPeerConnection>();
  /**
   * Who the server says is in the room. Kept because being in the room and
   * having a connection are different facts, and the gap between them is what
   * has to be retried.
   */
  private roster = new Set<string>();
  /** peerId → when to try dialling again. */
  private retryAt = new Map<string, number>();
  /** peerId → when the current connection attempt began. */
  private attemptAt = new Map<string, number>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private leaseTimer?: ReturnType<typeof setInterval>;
  private channels = new Map<string, RTCDataChannel>();
  private config: PeerConfig;
  private _disconnected = false;   // true after explicit disconnect()
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _stableTimer: ReturnType<typeof setTimeout> | null = null;
  // Peers that are data-only (AI agents): never push call media to them. They have no
  // speaker/headset, can echo our audio back through their WebRTC stack, and the call
  // renegotiation needlessly churns their connection. Populated by the app.
  readonly dataOnly = new Set<string>();

  // Reconnect backoff: doubles on each failed attempt up to a cap, with ±50% jitter
  // (so concurrent peers/tabs desync instead of retrying in lock-step). CRUCIAL: the
  // backoff only RESETS to the floor after a connection stays up ≥ STABLE_MS — a
  // rate-limited open-then-instant-close must keep backing off, not reset every cycle.
  private _reconnectDelay = 1500;
  private static readonly RECONNECT_MIN = 1500;
  private static readonly RECONNECT_MAX = 30000;
  private static readonly STABLE_MS = 15000;

  /// How often to look for peers in the room we have no channel to.
  private static readonly SWEEP_MS = 8_000;
  /// Minimum gap between dial attempts at one peer.
  private static readonly RETRY_INTERVAL_MS = 10_000;
  /// Extra wait before the LARGER-id side steps in as a fallback dialler. The
  /// smaller id is the normal initiator; the larger only dials if the peer has
  /// stayed unconnected past this — covers a dead or old-build smaller peer,
  /// without both sides racing (and glaring) in the common case.
  private static readonly FALLBACK_EXTRA_MS = 15_000;
  /// How long a connection may be "connecting" before it counts as stuck. Long
  /// enough for a slow path (mobile: more candidates, longer checks) to finish.
  private static readonly ATTEMPT_PATIENCE_MS = 45_000;

  // Live-call media: the local mic/cam stream shared into all connections, and a
  // per-peer "we have an outstanding offer" flag for perfect-negotiation glare
  // (only reachable via media renegotiation now, not establishment).
  private localStream: MediaStream | null = null;
  private makingOffer = new Map<string, boolean>();

  // Per-peer grace timer for a transient ICE "disconnected": WebRTC can briefly
  // flap to "disconnected" and recover. We only act if it has not recovered
  // within this window.
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly DISCONNECT_GRACE_MS = 8000;

  constructor(config: PeerConfig) {
    this.config = config;
    this.peerId = config.peerId ?? claimPeerId();
    try {
      this.leaseTimer = setInterval(() => touchLease(this.peerId), LEASE_TICK_MS);
    } catch { /* no storage, no lease */ }
  }

  connect(): void {
    this._disconnected = false;
    if (!validateCapability(this.config.roomId)) {
      console.warn(`[qos-peer] roomId ZFA check failed (may be cached token): ${this.config.roomId}`);
    }
    this._openSignaling().catch(() => this._scheduleReconnect());
    if (!this.sweepTimer) this.sweepTimer = setInterval(() => this.sweep(), QOSPeer.SWEEP_MS);
  }

  disconnect(): void {
    this._disconnected = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._stableTimer) clearTimeout(this._stableTimer);
    this.signal({ type: "leave", roomId: this.config.roomId, peerId: this.peerId });
    for (const pc of this.connections.values()) pc.close();
    this.ws?.close();
    this.connections.clear();
    this.channels.clear();
    for (const t of this.disconnectTimers.values()) clearTimeout(t);
    this.disconnectTimers.clear();
  }

  /// Recover promptly after a background-throttled / frozen tab returns to the
  /// foreground. If signaling is dead, reconnect NOW (cancel the throttled
  /// backoff and reset it); if it's alive, re-join so the server re-sends the
  /// peer list and we re-establish any channels that lapsed.
  wake(): void {
    if (this._disconnected) return;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
      this._reconnectDelay = QOSPeer.RECONNECT_MIN;
      void this._reconnectSignaling();
    } else if (ws.readyState === WebSocket.OPEN) {
      this.signal({ type: "join", roomId: this.config.roomId, peerId: this.peerId });
    }
  }

  /**
   * Manual "connect to this peer now" for the `/conn` diagnostic. Unlike the
   * sweep it dials regardless of which side is the normal initiator — a person
   * asking for it wants the link, not the etiquette.
   */
  redial(peerId: string): void {
    if (this._disconnected || peerId === this.peerId) return;
    this.roster.add(peerId);
    this.retryAt.delete(peerId);
    if (this.channels.get(peerId)?.readyState === "open") return;
    if (this.connecting(peerId)) return;
    void this.initiateConnection(peerId);
  }

  /// Whether the signaling WebSocket is currently open (used to label status).
  isSignalingUp(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  /// Whether a data channel to this peer is open — whether anything we send
  /// them can actually arrive. Being in the room is NOT the same thing: the
  /// signaling server can list a peer whose WebRTC handshake never completed.
  hasChannel(peerId: string): boolean {
    return this.channels.get(peerId)?.readyState === "open";
  }

  /**
   * What every connection is doing right now. The roster says reachable or not;
   * this says why not. "checking" that never ends is candidates that never
   * pair; "failed" is no path at all; "connected" with no open channel is a
   * different fault again.
   */
  connectionReport(): { peerId: string; channel: string; connection: string; ice: string }[] {
    const ids = new Set([...this.roster, ...this.connections.keys(), ...this.channels.keys()]);
    ids.delete(this.peerId);
    return [...ids].map((peerId) => ({
      peerId,
      channel: this.channels.get(peerId)?.readyState ?? "none",
      connection: this.connections.get(peerId)?.connectionState ?? "none",
      ice: this.connections.get(peerId)?.iceConnectionState ?? "none",
    }));
  }

  /// Send data to a specific peer. Returns false if no open channel to them.
  send(targetPeerId: string, data: unknown): boolean {
    const ch = this.channels.get(targetPeerId);
    if (ch && ch.readyState === "open") {
      ch.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  /// Broadcast to every peer we hold an open channel to (full mesh — that is
  /// everyone in the room).
  broadcast(data: unknown): void {
    const payload = JSON.stringify(data);
    for (const ch of this.channels.values()) {
      if (ch.readyState === "open") ch.send(payload);
    }
  }

  /// Largest send-buffer backlog across open channels (bytes) — used to pace
  /// large chunked transfers so we don't overflow the SCTP send buffer.
  maxBufferedAmount(): number {
    let max = 0;
    for (const ch of this.channels.values()) {
      if (ch.readyState === "open" && ch.bufferedAmount > max) max = ch.bufferedAmount;
    }
    return max;
  }

  /// Start sharing a local mic/camera stream into every peer connection (live
  /// call). Adds the tracks and renegotiates each connection.
  addLocalMedia(stream: MediaStream): void {
    this.localStream = stream;
    for (const [peerId, pc] of this.connections) {
      if (this.dataOnly.has(peerId)) continue;   // agents never get call media
      for (const track of stream.getTracks()) {
        if (!pc.getSenders().some((s) => s.track === track)) pc.addTrack(track, stream);
      }
      void this.renegotiate(peerId, pc);
    }
  }

  /// The senders carrying our video, one per connection that has one. A screen
  /// share replaces the track on all of them.
  videoSenders(): RTCRtpSender[] {
    const out: RTCRtpSender[] = [];
    for (const [peerId, pc] of this.connections) {
      if (this.dataOnly.has(peerId)) continue;
      for (const s of pc.getSenders()) if (s.track?.kind === "video") out.push(s);
    }
    return out;
  }

  /// Stop sharing local media: remove our senders from every connection and
  /// renegotiate. The remote sees the tracks end.
  removeLocalMedia(): void {
    const stream = this.localStream;
    this.localStream = null;
    if (!stream) return;
    const mine = new Set(stream.getTracks());
    for (const [peerId, pc] of this.connections) {
      for (const sender of pc.getSenders()) {
        if (sender.track && mine.has(sender.track)) {
          try { pc.removeTrack(sender); } catch { /* already gone */ }
        }
      }
      void this.renegotiate(peerId, pc);
    }
  }

  /// Send a fresh offer on an established connection (media (re)negotiation).
  /// Glare is resolved by handleOffer's polite/impolite rule.
  private async renegotiate(peerId: string, pc: RTCPeerConnection): Promise<void> {
    try {
      this.makingOffer.set(peerId, true);
      const offer = await pc.createOffer();
      if (pc.signalingState !== "stable") return;   // a remote offer landed first
      await pc.setLocalDescription(offer);
      this.signal({
        type: "offer", roomId: this.config.roomId,
        from: this.peerId, to: peerId, sdp: pc.localDescription!.sdp,
      });
    } catch (e) {
      console.warn("[qos-peer] renegotiate failed", e);
    } finally {
      this.makingOffer.set(peerId, false);
    }
  }

  private async _openSignaling(): Promise<void> {
    const ws = new WebSocket(this.config.signalingUrl);
    this.ws = ws;

    // CONNECT-TIMEOUT WATCHDOG. A hung/half-open signaling socket can fire NEITHER
    // `onopen` NOR `onerror` (the server accepts the TCP then never completes the WS
    // handshake). Without a bound this connect promise never settles and the peer
    // wedges — alive but permanently disconnected. Bound it: close and reject so the
    // caller reschedules with backoff.
    const CONNECT_TIMEOUT_MS = 20000;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error("signaling connect timeout"));
      }, CONNECT_TIMEOUT_MS);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = (e) => { clearTimeout(t); reject(e); };
    });

    // Reset the backoff only once the connection PROVES stable (≥ STABLE_MS). A
    // rate-limited server opens then immediately drops us; resetting on `open` alone
    // would relaunch the storm at the floor delay every cycle.
    if (this._stableTimer) clearTimeout(this._stableTimer);
    this._stableTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.OPEN) this._reconnectDelay = QOSPeer.RECONNECT_MIN;
    }, QOSPeer.STABLE_MS);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as SignalMsg;
        this.handleSignal(msg);
      } catch {
        console.error("[qos-peer] invalid signal message");
      }
    };

    ws.onclose = () => {
      if (this._stableTimer) { clearTimeout(this._stableTimer); this._stableTimer = null; }
      if (this._disconnected) return;
      this.config.onSignalingClose?.();
      this._scheduleReconnect();
    };

    this.signal({ type: "join", roomId: this.config.roomId, peerId: this.peerId });
    this.config.onSignalingOpen?.();
  }

  /// Schedule a reconnect with exponential backoff + ±50% jitter, single-flight.
  private _scheduleReconnect(): void {
    if (this._disconnected || this._reconnectTimer) return;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, QOSPeer.RECONNECT_MAX);
    const delay = Math.round(this._reconnectDelay * (0.5 + Math.random()));
    console.warn(`[qos-peer] signaling disconnected — reconnecting in ${(delay / 1000).toFixed(1)}s`);
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; void this._reconnectSignaling(); }, delay);
  }

  private async _reconnectSignaling(): Promise<void> {
    if (this._disconnected) return;
    try {
      await this._openSignaling();
      console.log("[qos-peer] signaling reconnected");
    } catch {
      this._scheduleReconnect();
    }
  }

  /// For any pair, the lexicographically-smaller id is the one that dials.
  private initiates(peerId: string): boolean {
    return this.peerId < peerId;
  }

  private handleSignal(msg: SignalMsg): void {
    switch (msg.type) {
      case "peers": {
        // On signaling reconnect the server re-sends the peers list. onPeerJoined
        // fires for everyone (the app's roster shows all present); reestablish()
        // rebuilds any connection that isn't fully healthy.
        this.roster = new Set(msg.peers);
        for (const peerId of msg.peers) {
          this.config.onPeerJoined?.(peerId);
          this.reestablish(peerId);
        }
        break;
      }
      case "joined":
        this.roster.add(msg.peerId);
        this.config.onPeerJoined?.(msg.peerId);
        // A "joined" for a peer we already hold a connection to means they
        // reconnected (a phone waking, a reload). Our side is stale — a data
        // channel can still read "open" while it reaches a frozen tab — so
        // reestablish() drops it and rebuilds per the dial rule.
        this.reestablish(msg.peerId);
        break;
      case "left":
        this.roster.delete(msg.peerId);
        this.retryAt.delete(msg.peerId);
        this.cleanup(msg.peerId);
        this.config.onPeerLeft?.(msg.peerId);
        break;
      case "offer":
        this.handleOffer(msg.from, msg.sdp);
        break;
      case "answer":
        this.handleAnswer(msg.from, msg.sdp);
        break;
      case "ice":
        this.handleIce(msg.from, msg.candidate);
        break;
      case "error":
        // Surfaced, not swallowed. "rate limit exceeded" is the server telling us
        // the join burst was bigger than it will carry.
        console.error("[signaling]", msg.message);
        this.config.onSignalingError?.(msg.message);
        break;
    }
  }

  /**
   * Dial the peers we are in a room with and have no channel to.
   *
   * The smaller-id side of each pair is the normal initiator and retries every
   * RETRY_INTERVAL_MS. The larger-id side only dials after an extra
   * FALLBACK_EXTRA_MS — so a peer whose smaller side is dead or on an old build
   * still connects, without both sides racing (and glaring) in the common case.
   */
  private sweep(): void {
    if (this._disconnected || !this.isSignalingUp()) return;
    const now = Date.now();
    for (const peerId of this.roster) {
      if (peerId === this.peerId) continue;
      if (this.channels.get(peerId)?.readyState === "open") continue;
      // An attempt already under way is not a failure to retry. Redialling it
      // sends a fresh offer with a new ICE ufrag, the far side rebuilds, and the
      // negotiation in flight is discarded — a slow path would never finish.
      if (this.connecting(peerId)) continue;
      if (now < (this.retryAt.get(peerId) ?? 0)) continue;
      const wait = QOSPeer.RETRY_INTERVAL_MS + (this.initiates(peerId) ? 0 : QOSPeer.FALLBACK_EXTRA_MS);
      // Jitter, so a room that all failed at once does not all retry at once.
      this.retryAt.set(peerId, now + Math.round(wait * (0.75 + Math.random() * 0.5)));
      console.log(`[qos-peer] dialling ${peerId.slice(-8)}`);
      void this.initiateConnection(peerId);
    }
  }

  /**
   * Make sure we have a healthy connection to this peer, rebuilding if not.
   *
   * Called for every peer on a fresh `peers` list (a signaling (re)connect) and
   * on every `joined`. A "joined" for a peer we already have a connection to
   * means they reconnected — a phone waking from sleep, a browser reload — and
   * our side of that connection is now stale: the peer's ICE session is fresh,
   * but a data channel can still read "open" for a while as it points at a
   * frozen tab, so nothing would redial and messages to them would vanish.
   * Drop anything that isn't fully healthy and re-establish per the dial rule.
   */
  private reestablish(peerId: string): void {
    if (peerId === this.peerId || this._disconnected) return;
    const pc = this.connections.get(peerId);
    const healthy = pc?.connectionState === "connected"
      && this.channels.get(peerId)?.readyState === "open";
    if (healthy) return;
    if (this.connecting(peerId)) return;   // a fresh attempt is already running
    if (pc) this.cleanup(peerId);          // drop the stale one
    this.retryAt.delete(peerId);
    // Initiator dials now; the other side waits for that offer (sweep's
    // FALLBACK_EXTRA_MS covers a no-show).
    if (this.initiates(peerId)) void this.initiateConnection(peerId);
  }

  /**
   * Is a connection to this peer still being made? "connecting"/"new" mean ICE
   * is still working; a check running longer than any real handshake takes is
   * treated as stuck, so a negotiation that silently died can't block retries.
   */
  private connecting(peerId: string): boolean {
    const pc = this.connections.get(peerId);
    if (!pc) return false;
    const state = pc.connectionState;
    if (state !== "new" && state !== "connecting") return false;
    const since = this.attemptAt.get(peerId) ?? 0;
    return Date.now() - since < QOSPeer.ATTEMPT_PATIENCE_MS;
  }

  private async initiateConnection(remotePeerId: string): Promise<void> {
    this.attemptAt.set(remotePeerId, Date.now());
    const pc = this.createPeerConnection(remotePeerId);

    const ch = pc.createDataChannel("qos");
    this.setupDataChannel(remotePeerId, ch);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.signal({
      type: "offer",
      roomId: this.config.roomId,
      from: this.peerId,
      to: remotePeerId,
      sdp: offer.sdp!,
    });
  }

  private async handleOffer(fromPeerId: string, sdp: string): Promise<void> {
    // Answering is an attempt too: the sweep must not dial a peer we are in the
    // middle of answering.
    this.attemptAt.set(fromPeerId, Date.now());
    let pc = this.connections.get(fromPeerId);
    // A fresh ICE session (different ice-ufrag) under a known peerId means the
    // peer reconnected / reloaded: the stale pc's data channel is dead, and
    // answering on it would NOT surface the peer's new data channel
    // (`ondatachannel` doesn't re-fire on a renegotiation) — the peer would
    // connect-but-stay-silent. Rebuild a clean pc instead of renegotiating the
    // corpse.
    if (pc && iceUfrag(pc.remoteDescription?.sdp) && iceUfrag(pc.remoteDescription?.sdp) !== iceUfrag(sdp)) {
      this.makingOffer.set(fromPeerId, false);
      pc = undefined;
    }
    if (!pc) {
      pc = this.createPeerConnection(fromPeerId);
      pc.ondatachannel = (event) => this.setupDataChannel(fromPeerId, event.channel);
    }

    // Perfect-negotiation glare handling — only reachable now via media
    // renegotiation (both sides may offer) or a mixed-build peer that still
    // both-dials for establishment. The peer with the smaller ID is polite.
    const polite = this.peerId < fromPeerId;
    const collision = (this.makingOffer.get(fromPeerId) ?? false) || pc.signalingState !== "stable";
    if (collision && !polite) return;   // impolite peer ignores — its own offer wins

    try {
      if (collision && polite) {
        await pc.setLocalDescription({ type: "rollback" });
      }
      await pc.setRemoteDescription({ type: "offer", sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal({
        type: "answer",
        roomId: this.config.roomId,
        from: this.peerId,
        to: fromPeerId,
        sdp: pc.localDescription!.sdp,
      });
    } catch (e) {
      console.warn("[qos-peer] handleOffer failed", e);
    }
  }

  private async handleAnswer(fromPeerId: string, sdp: string): Promise<void> {
    const pc = this.connections.get(fromPeerId);
    if (!pc) return;
    if (pc.signalingState !== "have-local-offer") return;   // stray/rolled-back answer
    try { await pc.setRemoteDescription({ type: "answer", sdp }); }
    catch (e) { console.warn("[qos-peer] handleAnswer failed", e); }
  }

  private async handleIce(fromPeerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this.connections.get(fromPeerId);
    if (!pc) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch { /* benign during glare rollback */ }
  }

  private createPeerConnection(remotePeerId: string): RTCPeerConnection {
    // Replacing our own connection is not the peer leaving. Closing a connection
    // fires its state handlers, and those declare the peer gone — so a retry
    // would produce a spurious "left" then "joined". Detach before closing.
    const stale = this.connections.get(remotePeerId);
    if (stale) {
      stale.onconnectionstatechange = null;
      stale.oniceconnectionstatechange = null;
      stale.onicegatheringstatechange = null;
      stale.onicecandidate = null;
      stale.ondatachannel = null;
      stale.ontrack = null;
      const ch = this.channels.get(remotePeerId);
      if (ch) { ch.onclose = null; ch.onopen = null; ch.onmessage = null; }
      stale.close();
    }

    const pc = new RTCPeerConnection({
      iceServers: this.config.iceServers ?? DEFAULT_ICE,
    });

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.signal({
        type: "ice",
        roomId: this.config.roomId,
        from: this.peerId,
        to: remotePeerId,
        candidate: event.candidate.toJSON(),
      });
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.config.onRemoteTrack?.(remotePeerId, stream);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[qos-peer] ice to ${remotePeerId.slice(-8)} → ${pc.iceConnectionState}`);
    };
    pc.onicegatheringstatechange = () => {
      console.log(`[qos-peer] gathering for ${remotePeerId.slice(-8)} → ${pc.iceGatheringState}`);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[qos-peer] connection to ${remotePeerId.slice(-8)} → ${state}`);
      if (state === "connected") {
        this.clearDisconnectTimer(remotePeerId);
        return;
      }
      if (state === "failed" || state === "closed") {
        this.clearDisconnectTimer(remotePeerId);
        // "failed" means no candidate pair worked — not "they left". If signaling
        // still lists them, keep them: tear down the dead pc so the sweep
        // redials, back the retry off one cycle, and let the app mark them
        // unreachable (⚠). The authoritative "they left" is the signaling "left"
        // message; a peer we held a channel to also reports departure via the
        // data-channel onclose path.
        if (remotePeerId !== this.peerId && this.roster.has(remotePeerId)) {
          this.cleanup(remotePeerId);
          this.retryAt.set(remotePeerId, Date.now() + QOSPeer.RETRY_INTERVAL_MS);
          return;
        }
        this.declarePeerGone(remotePeerId);
        return;
      }
      if (state === "disconnected") {
        // Possibly transient: start a grace timer, act only if it doesn't recover.
        if (!this.disconnectTimers.has(remotePeerId)) {
          const t = setTimeout(() => {
            this.disconnectTimers.delete(remotePeerId);
            const cur = this.connections.get(remotePeerId)?.connectionState;
            if (cur === "connected") return;   // recovered
            if (this.roster.has(remotePeerId)) {
              this.cleanup(remotePeerId);
              this.retryAt.set(remotePeerId, Date.now() + QOSPeer.RETRY_INTERVAL_MS);
              return;
            }
            this.declarePeerGone(remotePeerId);
          }, QOSPeer.DISCONNECT_GRACE_MS);
          this.disconnectTimers.set(remotePeerId, t);
        }
      }
    };

    this.connections.set(remotePeerId, pc);
    return pc;
  }

  private setupDataChannel(peerId: string, ch: RTCDataChannel): void {
    ch.onopen = () => {
      this.channels.set(peerId, ch);
      this.retryAt.delete(peerId);
      this.attemptAt.delete(peerId);
      this.config.onChannelOpen?.(peerId);
      console.log(`[qos-peer] data channel open with ${peerId}`);
      // If a call is already in progress, push our media to the newcomer (never
      // to data-only agents).
      if (this.localStream && !this.dataOnly.has(peerId)) {
        const pc = this.connections.get(peerId);
        if (pc) {
          for (const t of this.localStream.getTracks()) {
            if (!pc.getSenders().some((s) => s.track === t)) pc.addTrack(t, this.localStream);
          }
          void this.renegotiate(peerId, pc);
        }
      }
    };
    ch.onclose = () => {
      this.channels.delete(peerId);
      console.log(`[qos-peer] data channel closed with ${peerId}`);
      // A channel close is NOT the same as "they left". A phone that goes to
      // sleep freezes its tab and tears the SCTP association down — the peer is
      // still in the room and will be back when the screen wakes. If signaling
      // still lists them, keep them: tear down the dead pc so the sweep redials,
      // back the retry off one cycle, and let the app mark them ⚠ (not gone).
      // A genuine tab-close drops the signaling socket too, so `left` arrives
      // within about a second and declares them gone properly. Only a channel
      // close for a peer signaling has already forgotten is a departure here.
      if (peerId !== this.peerId && this.roster.has(peerId)) {
        this.cleanup(peerId);
        this.retryAt.set(peerId, Date.now() + QOSPeer.RETRY_INTERVAL_MS);
        return;
      }
      this.declarePeerGone(peerId);
    };
    ch.onmessage = (event) => {
      let data: unknown;
      try { data = JSON.parse(event.data); }
      catch { this.config.onMessage?.(peerId, event.data); return; }
      this.config.onMessage?.(peerId, data);
    };
  }

  private cleanup(peerId: string): void {
    this.connections.get(peerId)?.close();
    this.connections.delete(peerId);
    this.channels.delete(peerId);
  }

  private clearDisconnectTimer(peerId: string): void {
    const t = this.disconnectTimers.get(peerId);
    if (t !== undefined) { clearTimeout(t); this.disconnectTimers.delete(peerId); }
  }

  /// Tear down a peer's connection and notify the app it left. Idempotent: a
  /// data-channel close and a connection-state "failed" for the same peer both
  /// land here, but the second call is a no-op.
  private declarePeerGone(peerId: string): void {
    this.clearDisconnectTimer(peerId);
    const had = this.connections.has(peerId) || this.channels.has(peerId);
    this.cleanup(peerId);
    if (had) this.config.onPeerLeft?.(peerId);
  }

  private signal(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}

// Reusable persistent QuantumOS peer for Node — the reconnecting analog of
// packages/browser/src/peer.ts, on `ws` + `werift`.
//
// Identity (peerId) is supplied by the caller (so a daemon can keep a stable
// cap:peer across restarts). Mirrors peer.ts: full mesh, data channel label
// "qos", offer/answer/ice over signaling, signaling reconnect with backoff, and
// the single-dialer rule — for any pair the lexicographically-SMALLER id dials,
// the larger only answers (with a fallback dial after a grace period).

import WebSocket from "ws";
// werift, plus the RTCCertificate.getFingerprints() memo for quantum-os#125 —
// importing it here patches the shared prototype for every werift consumer.
import { RTCPeerConnection } from "./werift-patched.mjs";

const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
// How long a connection may sit in ICE "disconnected" before we tear it down.
// Long enough to ride out a real network blip, short enough that a departed peer
// cannot leave an SCTP association retransmitting forever. See `_newPC`.
const DISCONNECT_GRACE_MS = 30_000;

const ATTEMPT_PATIENCE_MS = 45_000;   // how long a dial/answer in flight is left alone before a redial
const SWEEP_MS = 8_000;               // how often to look for roster peers with no channel
const RETRY_INTERVAL_MS = 10_000;     // minimum gap between dial attempts at one peer
const FALLBACK_EXTRA_MS = 15_000;     // extra wait before the LARGER-id side steps in as fallback dialler

// The ICE username fragment identifies an ICE session; a peer that reconnects (or
// reloads its browser) brings a new one. Used to tell a genuine renegotiation
// (same ufrag) from a reconnect under the same peerId (new ufrag). Null if absent.
function _iceUfrag(sdp) {
  const m = /a=ice-ufrag:(\S+)/.exec(sdp ?? "");
  return m ? m[1] : null;
}

export class QOSPeer {
  constructor(config) {
    this.config = config;                 // { signalingUrl, roomId, peerId, iceServers?, on* }
    this.peerId = config.peerId;
    this.ws = null;
    this.connections = new Map();         // remoteId -> RTCPeerConnection
    this.channels = new Map();            // remoteId -> data channel
    this.makingOffer = new Map();         // remoteId -> we have an outstanding offer (perfect-negotiation glare)
    this.attemptAt = new Map();           // remoteId -> when the current dial/answer began (see _connecting)
    this.retryAt = new Map();             // remoteId -> earliest next dial attempt (see _sweep)
    this._disconnected = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._sweepTimer = null;
    this.roster = new Set();              // who the server says is in the room
    this._autoTurn = [];                  // fetched relay, see _loadAutoTurn
  }

  connect() {
    this._disconnected = false;
    this._openSignaling().catch(() => this._scheduleReconnect());
    void this._loadAutoTurn();
    if (!this._sweepTimer) {
      this._sweepTimer = setInterval(() => this._sweep(), SWEEP_MS);
      this._sweepTimer.unref?.();
    }
  }

  /// Mirrors the browser's fetchAutoTurn (app.ts): a short-lived, Cloudflare-
  /// minted TURN credential from the signaling server's own GET /turn — never
  /// from Cloudflare directly, and the master API token never reaches this
  /// process either. A cross-network peer needs a relay on at least one side to
  /// form a direct connection, so agents get the same relay browsers do.
  /// Skipped entirely when the caller passed an explicit iceServers (tests, an
  /// override). Best-effort: any failure just leaves iceServers as-is.
  async _loadAutoTurn() {
    if (this.config.iceServers) return;
    try {
      const base = this.config.signalingUrl.replace(/^ws/, "http");
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      let res;
      try { res = await fetch(`${base}/turn`, { signal: ctrl.signal }); }
      finally { clearTimeout(t); }
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data?.iceServers)) this._autoTurn = data.iceServers;
    } catch { /* best-effort — stays on DEFAULT_ICE alone */ }
  }

  _iceServers() {
    return this.config.iceServers ?? [...DEFAULT_ICE, ...this._autoTurn];
  }

  /// Is this channel usable? Some transports (werift) don't always expose a
  /// readyState — treat that as open, matching this file's existing send().
  _channelOpen(ch) {
    return !!ch && (!ch.readyState || ch.readyState === "open");
  }

  /// For any pair, the lexicographically-smaller id is the one that dials.
  _initiates(peerId) {
    return this.peerId < peerId;
  }

  /// A dial or answer to this peer is still in progress — don't start another
  /// (a fresh `_newPC` closes the pc mid-negotiation and both sides restart).
  /// A stale attempt (older than ATTEMPT_PATIENCE_MS) no longer counts.
  _connecting(peerId) {
    const pc = this.connections.get(peerId);
    if (!pc) return false;
    const st = pc.connectionState ?? pc.iceConnectionState;
    if (st && st !== "new" && st !== "connecting" && st !== "checking") return false;
    return Date.now() - (this.attemptAt.get(peerId) ?? 0) < ATTEMPT_PATIENCE_MS;
  }

  /// Dial roster peers we hold no channel to. The smaller-id side of each pair
  /// is the normal initiator (retries every RETRY_INTERVAL_MS); the larger only
  /// steps in after an extra FALLBACK_EXTRA_MS, covering a dead or old-build
  /// smaller peer without both sides racing (and glaring) in the common case.
  _sweep() {
    if (this._disconnected || this.ws?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    for (const peerId of this.roster) {
      if (peerId === this.peerId) continue;
      if (this._channelOpen(this.channels.get(peerId))) continue;
      if (this._connecting(peerId)) continue;
      if (now < (this.retryAt.get(peerId) ?? 0)) continue;
      const wait = RETRY_INTERVAL_MS + (this._initiates(peerId) ? 0 : FALLBACK_EXTRA_MS);
      this.retryAt.set(peerId, now + Math.round(wait * (0.75 + Math.random() * 0.5)));
      this._initiate(peerId).catch((e) => this.config.onError?.(e));
    }
  }

  // Reconnect with EXPONENTIAL BACKOFF + JITTER, single-flight. The signaling
  // server rate-limits: a fixed-interval reconnect makes N agents re-hammer it in
  // lock-step → "rate limit exceeded" → drop → storm. Backoff (3s→6→12→24→cap 60s)
  // gives the limit time to clear; ±50% jitter desyncs the agents. `_reconnectAttempts`
  // only resets once a connection stays up ≥15s (see `_openSignaling`).
  _scheduleReconnect() {
    if (this._disconnected || this._reconnectTimer) return; // single-flight
    const base = Math.min(3000 * 2 ** this._reconnectAttempts, 60000);
    const delay = Math.round(base * (0.5 + Math.random()));
    this._reconnectAttempts++;
    this.config.onReconnectScheduled?.(delay);
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this._reconnect(); }, delay);
  }

  disconnect() {
    this._disconnected = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    this._signal({ type: "leave", roomId: this.config.roomId, peerId: this.peerId });
    for (const pc of this.connections.values()) { try { pc.close(); } catch {} }
    try { this.ws?.close(); } catch {}
    this.connections.clear();
    this.channels.clear();
  }

  /// Send to a specific peer. Returns false if no open channel to them.
  send(targetPeerId, data) {
    const ch = this.channels.get(targetPeerId);
    if (this._channelOpen(ch)) {
      try { ch.send(JSON.stringify(data)); return true; } catch { return false; }
    }
    return false;
  }

  /// Broadcast to every peer we hold an open channel to (full mesh).
  broadcast(data) {
    const payload = JSON.stringify(data);
    for (const ch of this.channels.values()) {
      if (this._channelOpen(ch)) { try { ch.send(payload); } catch {} }
    }
  }

  _signal(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async _openSignaling() {
    const ws = new WebSocket(this.config.signalingUrl);
    this.ws = ws;
    // CONNECT-TIMEOUT WATCHDOG. A hung/half-open signaling socket can fire NEITHER
    // "open" NOR "error": the server accepts the TCP then never completes the WS
    // handshake. Without a bound the connect promise never settles and the daemon
    // WEDGES — alive but permanently disconnected. Bound the handshake and reject
    // so the caller reschedules with backoff.
    const CONNECT_TIMEOUT_MS = 20000;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        try { ws.terminate(); } catch {}
        reject(new Error("signaling connect timeout"));
      }, CONNECT_TIMEOUT_MS);
      ws.on("open", () => { clearTimeout(t); resolve(); });
      ws.on("error", (e) => { clearTimeout(t); reject(e); });
    });
    // Only reset the backoff once the connection has stayed up ≥15s. A rate-limited
    // server opens then immediately drops us; without this gate each such cycle
    // would reset the backoff to 3s and re-storm.
    const stableTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.OPEN) this._reconnectAttempts = 0;
    }, 15000);
    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      this._handleSignal(msg);
    });
    // Heartbeat. The signaling server can drop an idle/half-open socket WITHOUT a
    // clean close, leaving us a zombie — still connected to current peers but blind
    // to every new joiner. Ping every 30s; terminate only after TWO consecutive
    // missed pongs (~60s of silence) so the "close" handler reconnects. Tolerating
    // one missed pong matters: a slow/sleepy host's one-off late pong used to
    // false-terminate a good connection.
    let missed = 0;
    ws.on("pong", () => { missed = 0; });
    const heartbeat = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (missed >= 2) { try { ws.terminate(); } catch {} return; }
      missed++;
      try { ws.ping(); } catch {}
    }, 30000);
    ws.on("close", (code, reason) => {
      clearInterval(heartbeat);
      clearTimeout(stableTimer);
      if (this._disconnected) return;
      this.config.onSignalingClose?.(code, String(reason ?? ""));
      this._scheduleReconnect();
    });
    this._signal({ type: "join", roomId: this.config.roomId, peerId: this.peerId });
    this.config.onSignalingOpen?.();
  }

  async _reconnect() {
    if (this._disconnected) return;
    try { await this._openSignaling(); }
    catch { this._scheduleReconnect(); }
  }

  _handleSignal(msg) {
    switch (msg.type) {
      case "peers": {
        // onPeerJoined fires for everyone (the app's roster shows all present);
        // we dial only the peers we're the initiator for and hold no channel to.
        this.roster = new Set(msg.peers);
        for (const peerId of msg.peers) {
          this.config.onPeerJoined?.(peerId);
          if (peerId === this.peerId) continue;
          if (this._channelOpen(this.channels.get(peerId))) continue;
          if (this._connecting(peerId)) continue;
          if (this._initiates(peerId)) this._initiate(peerId).catch((e) => this.config.onError?.(e));
        }
        break;
      }
      case "joined":
        this.roster.add(msg.peerId);
        this.config.onPeerJoined?.(msg.peerId);
        if (this._initiates(msg.peerId)
          && !this._channelOpen(this.channels.get(msg.peerId))
          && !this._connecting(msg.peerId)) {
          this._initiate(msg.peerId).catch((e) => this.config.onError?.(e));
        }
        break;
      case "left":
        this.roster.delete(msg.peerId);
        this.retryAt.delete(msg.peerId);
        this._cleanup(msg.peerId);
        this.config.onPeerLeft?.(msg.peerId);
        break;
      case "offer":  this._handleOffer(msg.from, msg.sdp).catch((e) => this.config.onError?.(e)); break;
      case "answer": this._handleAnswer(msg.from, msg.sdp).catch((e) => this.config.onError?.(e)); break;
      case "ice":    this._handleIce(msg.from, msg.candidate).catch(() => {}); break;
      case "error":  this.config.onError?.(new Error(msg.message)); break;
    }
  }

  _onIce(pc, handler) {
    if (pc.onIceCandidate?.subscribe) pc.onIceCandidate.subscribe((c) => handler(c));
    else pc.onicecandidate = (ev) => handler(ev?.candidate);
  }

  _newPC(remoteId) {
    try { this.connections.get(remoteId)?.close(); } catch {}
    const pc = new RTCPeerConnection({ iceServers: this._iceServers() });
    this._onIce(pc, (candidate) => {
      if (!candidate) return;
      this._signal({ type: "ice", roomId: this.config.roomId, from: this.peerId, to: remoteId, candidate: candidate.toJSON ? candidate.toJSON() : candidate });
    });
    const stateEvt = pc.connectionStateChange ?? pc.iceConnectionStateChange;
    // Teardown on BOTH terminal states. werift never escalates "disconnected" to
    // "failed" — its ICE layer has no consent-freshness timer — so a peer that
    // vanishes silently parks here forever, its SCTP association retransmitting at
    // full speed through pure-JS DTLS (one zombie peer pegged a core). "disconnected"
    // can also be a recoverable blip, so give it a grace period and re-check the
    // SAME pc is still stuck before dropping it.
    if (stateEvt?.subscribe) stateEvt.subscribe((s) => {
      if (s === "failed") { this._cleanup(remoteId); this.config.onPeerLeft?.(remoteId); }
      else if (s === "disconnected") {
        setTimeout(() => {
          if (this.connections.get(remoteId) !== pc) return;                       // already replaced/cleaned
          const now = pc.connectionState ?? pc.iceConnectionState;
          if (now !== "disconnected") return;                                      // recovered
          this._cleanup(remoteId);
          this.config.onPeerLeft?.(remoteId);
        }, DISCONNECT_GRACE_MS).unref?.();
      }
    });
    this.connections.set(remoteId, pc);
    return pc;
  }

  _setupChannel(remoteId, ch) {
    const onOpen = () => {
      this.channels.set(remoteId, ch);
      this.retryAt.delete(remoteId);
      this.attemptAt.delete(remoteId);
      this.config.onChannelOpen?.(remoteId);
    };
    if (ch.stateChanged?.subscribe) {
      ch.stateChanged.subscribe((state) => { if (state === "open") onOpen(); else if (state === "closed") this.channels.delete(remoteId); });
    } else {
      ch.onopen = onOpen;
      ch.onclose = () => this.channels.delete(remoteId);
    }
    const onMsg = (data) => {
      const payload = (data && typeof data === "object" && "data" in data) ? data.data : data;
      let d;
      try { d = JSON.parse(payload.toString()); }
      catch { this.config.onMessage?.(remoteId, payload?.toString?.() ?? payload); return; }
      this.config.onMessage?.(remoteId, d);
    };
    // werift exposes inbound as `onMessage` (an Event); browsers use `onmessage`.
    if (ch.onMessage?.subscribe) ch.onMessage.subscribe(onMsg);
    else if (ch.message?.subscribe) ch.message.subscribe(onMsg);
    else ch.onmessage = (ev) => onMsg(ev && typeof ev === "object" && "data" in ev ? ev.data : ev);
  }

  async _initiate(remoteId) {
    // Mark BEFORE any await: an offer from the other side that lands before our
    // setLocalDescription resolves still needs to read as glare.
    this.makingOffer.set(remoteId, true);
    this.attemptAt.set(remoteId, Date.now());
    try {
      const pc = this._newPC(remoteId);
      const ch = pc.createDataChannel("qos");
      this._setupChannel(remoteId, ch);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._signal({ type: "offer", roomId: this.config.roomId, from: this.peerId, to: remoteId, sdp: pc.localDescription?.sdp ?? offer.sdp });
    } finally {
      this.makingOffer.set(remoteId, false);
    }
  }

  async _handleOffer(fromId, sdp) {
    // Answering is an attempt too — the sweep must not dial a peer we are
    // mid-answer with (see _connecting).
    this.attemptAt.set(fromId, Date.now());
    // Renegotiation on a LIVE connection — e.g. a browser peer started a call and
    // added mic/cam, re-offering on the existing connection. Answer on the existing
    // pc; NEVER tear down a working data channel.
    //
    // CRUCIAL — reconnect vs. renegotiation. A peer that RELOADED keeps the same
    // peerId but dials in with a BRAND-NEW ICE session (fresh ice-ufrag). Answering
    // the fresh offer on the STALE pc never establishes a transport, so the reloaded
    // peer silently never reconnects. Only treat an offer as a renegotiation when
    // its ice-ufrag MATCHES the live connection's; a new ufrag → rebuild a clean pc.
    const existing = this.connections.get(fromId);
    const sameSession = existing
      && _iceUfrag(existing.remoteDescription?.sdp) !== null
      && _iceUfrag(existing.remoteDescription?.sdp) === _iceUfrag(sdp);
    const idle = !existing || (existing.signalingState ?? "stable") === "stable";
    if (existing && sameSession && idle && this.channels.get(fromId)?.readyState === "open") {
      try {
        await existing.setRemoteDescription({ type: "offer", sdp });
        this._rejectMedia(existing);
        const answer = await existing.createAnswer();
        await existing.setLocalDescription(answer);
        this._signal({ type: "answer", roomId: this.config.roomId, from: this.peerId, to: fromId, sdp: existing.localDescription?.sdp ?? answer.sdp });
      } catch (e) { this.config.onError?.(e); }
      return;
    }

    // Perfect-negotiation glare. Only reachable now via media renegotiation (both
    // sides may re-offer) or a mixed-build peer that still both-dials for
    // establishment. Tiebreak matches peer.ts: the SMALLER peerId yields and
    // answers; the larger keeps its own offer and ignores this one.
    const glare = (this.makingOffer.get(fromId) ?? false)
      || (existing && existing.signalingState && existing.signalingState !== "stable");
    if (glare && this.peerId > fromId) return;   // larger id: our offer wins, ignore theirs
    if (glare) this.makingOffer.set(fromId, false);   // smaller id: abandon ours, answer theirs

    const pc = this._newPC(fromId);
    if (pc.onDataChannel?.subscribe) pc.onDataChannel.subscribe((ch) => this._setupChannel(fromId, ch));
    else pc.ondatachannel = (ev) => this._setupChannel(fromId, ev.channel);
    await pc.setRemoteDescription({ type: "offer", sdp });
    this._rejectMedia(pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this._signal({ type: "answer", roomId: this.config.roomId, from: this.peerId, to: fromId, sdp: pc.localDescription?.sdp ?? answer.sdp });
  }

  // A node agent is data-only. When a browser peer starts a call it renegotiates
  // with EVERY peer — agents included — adding audio/video m-lines. werift otherwise
  // auto-creates recvonly transceivers and decrypts + parses every inbound RTP
  // packet in pure JS (~20% of a core per active call PER agent, for media nothing
  // here will use). Forcing every media transceiver inactive before we answer makes
  // werift emit a rejected m-line, so a compliant peer sends no RTP at all.
  _rejectMedia(pc) {
    try {
      for (const t of pc.getTransceivers?.() ?? []) {
        if ((t.kind === "audio" || t.kind === "video") && t.direction !== "inactive") {
          try { t.setDirection("inactive"); } catch {}
        }
      }
    } catch {}
  }

  async _handleAnswer(fromId, sdp) {
    const pc = this.connections.get(fromId);
    if (!pc) return;
    // An answer is only meaningful while our own offer is outstanding. Glare can
    // leave each side with an answer to an offer it has already replaced, which
    // werift reports as "Cannot handle answer in signaling state" — thrown, that
    // became a flap over a message that only needed ignoring.
    const state = pc.signalingState;
    if (state && state !== "have-local-offer") return;
    await pc.setRemoteDescription({ type: "answer", sdp });
    this.makingOffer.set(fromId, false);
  }

  async _handleIce(fromId, candidate) {
    const pc = this.connections.get(fromId);
    if (pc && candidate) { try { await pc.addIceCandidate(candidate); } catch {} }
  }

  _cleanup(peerId) {
    const pc = this.connections.get(peerId);
    // Drop the maps FIRST so a re-entrant cleanup (close() can itself fire a state
    // change) cannot double-close the same pc.
    this.connections.delete(peerId);
    this.channels.delete(peerId);
    this.makingOffer.delete(peerId);
    this.attemptAt.delete(peerId);
    // close() is async — it awaits sctpTransport.stop(), the step that stops the
    // retransmit timer. Fire-and-forget, but surface the rejection.
    try { Promise.resolve(pc?.close()).catch((e) => this.config.onError?.(e)); } catch {}
  }
}

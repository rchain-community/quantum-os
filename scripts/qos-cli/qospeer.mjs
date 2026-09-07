// Reusable persistent QuantumOS peer for Node — the reconnecting analog of
// packages/browser/src/peer.ts, on `ws` + `werift`.
//
// Identity (peerId) is supplied by the caller (so a daemon can keep a stable
// cap:peer across restarts). Mirrors peer.ts: data channel label "qos",
// offer/answer/ice over signaling, signaling reconnect 3s (then 5s on a failed
// retry), and skip re-establishing peers whose channel is still open when the
// server re-sends the peers list after a reconnect.

import WebSocket from "ws";
// werift, plus the RTCCertificate.getFingerprints() memo for quantum-os#125 —
// importing it here patches the shared prototype for every werift consumer.
import { RTCPeerConnection } from "./werift-patched.mjs";
import { ringSkipNeighbors } from "./ring-neighbors.mjs";

const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
// How long a connection may sit in ICE "disconnected" before we tear it down.
// Long enough to ride out a real network blip, short enough that a departed peer
// cannot leave an SCTP association retransmitting forever. See `_newPC`.
const DISCONNECT_GRACE_MS = 30_000;

// Bounded-degree overlay (ring + skip-links) constants — mirrors
// packages/browser/src/peer.ts's own. PRUNE_GRACE_MS sits between
// DISCONNECT_GRACE_MS (30s here, a real ICE blip) and the reconnect backoff
// ceiling (60s), giving a roster reshuffle time to settle before a still-
// working link is actually closed. REACHABLE_WINDOW_MS is 1.5x
// PRESENCE_FLOOD_MS, tolerating one missed beat — the same "miss one, not
// two" idiom as this file's own ping/pong heartbeat below.
const PRUNE_GRACE_MS = 30_000;
const SEEN_RELAY_MAX = 5000;
const REACHABLE_WINDOW_MS = 45_000;
const ATTEMPT_PATIENCE_MS = 45_000;   // how long a dial/answer in flight is left alone before a redial is allowed
const PRESENCE_FLOOD_MS = 30_000;

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
    this._disconnected = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    // Bounded-degree overlay state — see ringSkipNeighbors/targetPeers.
    this.roster = new Set();              // who the server says is in the room
    this.pins = new Set();                // peers we always want a direct link to
    this.pruneTimers = new Map();         // grace-then-close timers, see _reconcilePrune
    this.seenRelay = new Set();           // flood dedupe, see _handleRelay
    this._relayCounter = 0;
    this.lastHeardVia = new Map();        // peerId -> last relay-traffic timestamp, see isReachable
    this._presenceTimer = null;
    this._autoTurn = [];                  // fetched relay, see _loadAutoTurn
  }

  connect() {
    this._disconnected = false;
    this._openSignaling().catch(() => this._scheduleReconnect());
    void this._loadAutoTurn();
    // Keeps isReachable() honest for peers who are relay-only (past direct
    // reach) and otherwise never send anything themselves.
    if (!this._presenceTimer) {
      this._presenceTimer = setInterval(() => this.broadcast({ kind: "presence" }), PRESENCE_FLOOD_MS);
      this._presenceTimer.unref?.();
    }
  }

  /// Mirrors the browser's fetchAutoTurn (app.ts): a short-lived, Cloudflare-
  /// minted TURN credential from the signaling server's own GET /turn — never
  /// from Cloudflare directly, and the master API token never reaches this
  /// process either. An agent's chat relay (the flood overlay) only works if
  /// SOME agent actually holds a link to both sides of a NAT boundary, so
  /// agents get the same relay browsers do. Skipped entirely when the caller
  /// passed an explicit iceServers (tests, an override) — this only fills in
  /// the default. Best-effort: any failure just leaves iceServers as-is.
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

  /// A dial or answer to this peer is still in progress — don't start another
  /// (a fresh `_newPC` closes the pc mid-negotiation and both sides restart,
  /// which is how a `name` re-announce or a signaling reconnect turned into a
  /// rebuild storm). Mirrors peer.ts's `connecting()`. A stale attempt (older
  /// than ATTEMPT_PATIENCE_MS) no longer counts, so a genuinely dead one can be
  /// retried.
  _connecting(peerId) {
    const pc = this.connections.get(peerId);
    if (!pc) return false;
    const st = pc.connectionState ?? pc.iceConnectionState;
    if (st && st !== "new" && st !== "connecting" && st !== "checking") return false;
    return Date.now() - (this.attemptAt.get(peerId) ?? 0) < ATTEMPT_PATIENCE_MS;
  }

  /// Who we should be directly connected to right now: ring+skip neighbors
  /// (see ringSkipNeighbors) plus anything pinned. Full mesh falls out of
  /// this automatically for five or fewer peers.
  targetPeers() {
    const sorted = [...new Set([...this.roster, this.peerId])].sort();
    const set = ringSkipNeighbors(sorted, this.peerId);
    for (const p of this.pins) if (p !== this.peerId) set.add(p);
    return set;
  }

  /// Always keep a direct link to this peer regardless of ring/skip
  /// position — a local, one-sided decision (the other side has no wire
  /// signal that we just pinned them), so it dials immediately.
  pinNeighbor(peerId) {
    if (peerId === this.peerId) return;
    this.pins.add(peerId);
    if (this._channelOpen(this.channels.get(peerId))) return;
    if (this._connecting(peerId)) return;   // a dial is already in flight — don't restart it
    this._initiate(peerId).catch((e) => this.config.onError?.(e));
  }

  /// Release a pin. The link doesn't close instantly — same grace-then-prune
  /// path as any other connection that's fallen outside the target set.
  unpinNeighbor(peerId) {
    this.pins.delete(peerId);
    this._reconcilePrune();
  }

  /// Can we reach this peer at all — a direct channel, or relay traffic seen
  /// from them recently (including the periodic presence flood)? Distinct
  /// from "do we have a direct channel to them" — most peers past a handful
  /// in the room are reached over the overlay, not directly.
  isReachable(peerId) {
    if (this._channelOpen(this.channels.get(peerId))) return true;
    const last = this.lastHeardVia.get(peerId);
    return last !== undefined && Date.now() - last < REACHABLE_WINDOW_MS;
  }

  /**
   * DELIBERATELY INERT — see peer.ts's own _reconcilePrune/reconcilePrune for
   * the full rationale. Closing a working connection because ring math
   * shifted meant one flaky peer bouncing in and out could cascade into
   * closing OTHER peers' healthy connections too (a roster change reshuffles
   * ring positions for everyone) — observed live during testing. targetPeers
   * still bounds who gets newly dialled; an already-open connection is never
   * actively closed for falling outside the ring. _prunePeer/_clearPruneTimer
   * stay in place for a deliberate future re-enable.
   */
  _reconcilePrune() {
    // no-op — see above
  }

  _clearPruneTimer(peerId) {
    const t = this.pruneTimers.get(peerId);
    if (t !== undefined) { clearTimeout(t); this.pruneTimers.delete(peerId); }
  }

  /// Close a direct link that fell outside the target neighbor set — not a
  /// departure, so unlike the "left"/"failed" paths this never fires
  /// onPeerLeft. Safe: unlike peer.ts's data channel, this file's channel
  /// close/state-change handlers don't report a departure on their own, so
  /// there's no async re-fire to guard against.
  _prunePeer(peerId) {
    this._clearPruneTimer(peerId);
    this._cleanup(peerId);
  }

  _nextRelayId() {
    const id = `${this.peerId}:${this._relayCounter++}`;
    this.seenRelay.add(id);
    if (this.seenRelay.size > SEEN_RELAY_MAX) this.seenRelay.clear();
    return id;
  }

  _hopBudget() {
    return Math.max(4, Math.ceil((this.roster.size + 1) / 2));
  }

  // Reconnect with EXPONENTIAL BACKOFF + JITTER, single-flight. The free signaling
  // server rate-limits: a fixed-interval reconnect makes N agents re-hammer it in
  // lock-step → "rate limit exceeded" → drop → storm. Backoff (3s→6→12→24→cap 60s)
  // gives the limit time to clear; ±50% jitter desyncs the agents so they don't all
  // retry at once. `_reconnectAttempts` only resets once a connection stays up ≥15s
  // (see `_openSignaling`), so a connect-then-immediately-dropped (rate-limited)
  // cycle keeps backing off instead of resetting to 3s and storming again.
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
    if (this._presenceTimer) clearInterval(this._presenceTimer);
    this._signal({ type: "leave", roomId: this.config.roomId, peerId: this.peerId });
    for (const pc of this.connections.values()) { try { pc.close(); } catch {} }
    try { this.ws?.close(); } catch {}
    this.connections.clear();
    this.channels.clear();
    for (const t of this.pruneTimers.values()) clearTimeout(t);
    this.pruneTimers.clear();
  }

  /// Direct and raw if we hold an open channel to them (unchanged, byte-
  /// identical to before). Otherwise flood-routes over the bounded-degree
  /// overlay: tagged with a dedupe id, a remaining-hop budget, and who it's
  /// actually for, so every neighbor relays it onward until it reaches
  /// someone who is. No routing table — see peer.ts for the full rationale.
  send(targetPeerId, data) {
    const ch = this.channels.get(targetPeerId);
    if (this._channelOpen(ch)) {
      try { ch.send(JSON.stringify(data)); return true; } catch { return false; }
    }
    if (this.channels.size === 0) return false;
    const tagged = {
      ...data,
      _relayId: this._nextRelayId(), _hops: this._hopBudget(), _from: this.peerId, _relayTo: targetPeerId,
    };
    const payload = JSON.stringify(tagged);
    let sent = false;
    for (const other of this.channels.values()) {
      if (this._channelOpen(other)) { try { other.send(payload); sent = true; } catch {} }
    }
    return sent;
  }

  /// Flooded over the overlay (see ringSkipNeighbors) — tagged with a dedupe
  /// id and a remaining-hop budget so a peer beyond direct reach still gets
  /// it via relay. A room of five or fewer is still direct to everyone, so
  /// this degenerates to exactly the old fan-out.
  broadcast(data) {
    const tagged = { ...data, _relayId: this._nextRelayId(), _hops: this._hopBudget(), _from: this.peerId };
    const payload = JSON.stringify(tagged);
    // Write directly rather than through send(): every entry here is by
    // definition an open channel, so send()'s no-direct-link flood-fallback
    // — which would add a _relayTo that doesn't belong on a broadcast —
    // must never run here.
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
    // handshake (e.g. a free-tier signaling server that died mid-flight). Without a
    // bound the connect promise never settles, so `_openSignaling` hangs forever and
    // the daemon WEDGES — alive but permanently disconnected, never rescheduling a
    // reconnect. The post-open heartbeat below cannot help, because "open" never fired.
    // Bound the handshake: if "open" hasn't arrived within CONNECT_TIMEOUT_MS, terminate
    // the socket and reject so the caller (`connect`/`_reconnect`) reschedules with
    // backoff. This self-heals the wedge a hard signaling-server drop used to cause.
    const CONNECT_TIMEOUT_MS = 20000;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        try { ws.terminate(); } catch {}
        reject(new Error("signaling connect timeout"));
      }, CONNECT_TIMEOUT_MS);
      ws.on("open", () => { clearTimeout(t); resolve(); });
      ws.on("error", (e) => { clearTimeout(t); reject(e); });
    });
    // Only treat the connection as healthy (and reset the backoff) once it has stayed
    // up ≥15s. A rate-limited server opens then immediately drops us; without this gate
    // each such cycle would reset the backoff to 3s and re-storm.
    const stableTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.OPEN) this._reconnectAttempts = 0;
    }, 15000);
    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      this._handleSignal(msg);
    });
    // Heartbeat. The free signaling server can drop an idle/half-open socket WITHOUT a
    // clean close, which would leave us a zombie — still connected to current peers but
    // blind to every new joiner (no offer reaches us, so we never appear in their peer
    // list and never get to greet them). Ping every 30s; terminate only after TWO
    // consecutive missed pongs (~60s of silence) so the "close" handler reconnects.
    // Tolerating a single missed pong matters: the free server is often slow/sleepy and
    // a one-off late pong used to false-terminate a perfectly good connection every few
    // minutes — that was the residual leave/rejoin churn after the storm was fixed.
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
      // Why it closed, not just that it did. An agent that reconnects every
      // half minute is either being terminated by the server (1006 with no
      // reason, which is what a missed heartbeat looks like), sent away
      // deliberately (1000/1001), or losing the network under it — three causes
      // wanting three different fixes, and the log said only "dropped".
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
        // Dial our overlay targets only (see targetPeers/ringSkipNeighbors),
        // not everyone in the room — but onPeerJoined still fires for every
        // peer, unfiltered, so the app keeps seeing everyone present, direct
        // neighbor or not. This is the one moment we're a unilateral
        // initiator (we just (re)connected), so dialing immediately here is
        // safe; pruning is always safe (never opens a link, so it can't
        // glare).
        this.roster = new Set(msg.peers);
        const targets = this.targetPeers();
        for (const peerId of msg.peers) {
          this.config.onPeerJoined?.(peerId);
          if (!targets.has(peerId)) continue;
          if (this._channelOpen(this.channels.get(peerId))) continue;
          if (this._connecting(peerId)) continue;   // attempt in flight — leave it
          this._initiate(peerId).catch((e) => this.config.onError?.(e));
        }
        this._reconcilePrune();
        break;
      }
      case "joined":
        // The joiner dials us — see the "peers" case above; both sides may
        // now want each other, but only the joiner has the trigger to dial.
        this.roster.add(msg.peerId);
        this.config.onPeerJoined?.(msg.peerId); // newcomer initiates to us
        this._reconcilePrune();
        break;
      case "left":
        this.roster.delete(msg.peerId);
        // A genuine departure clears any pin too — see peer.ts's own "left"
        // case for the full rationale (otherwise a pin keeps chasing
        // someone provably gone forever).
        this.pins.delete(msg.peerId);
        this._clearPruneTimer(msg.peerId);
        this._cleanup(msg.peerId);
        this.config.onPeerLeft?.(msg.peerId);
        this._reconcilePrune();
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
    // vanishes silently (browser closed, lid shut, wifi dropped) parks here forever.
    // Cleaning up only on "failed" left `pc.close()` uncalled, so the SCTP transport
    // was never stopped and its association retransmitted its unacked queue at full
    // speed, re-encrypting every chunk through pure-JS DTLS — one zombie peer pegged
    // a core indefinitely. "disconnected" can also be a recoverable blip, so give it
    // a grace period and re-check that the SAME pc is still stuck before dropping it.
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
    const onOpen = () => { this.channels.set(remoteId, ch); this.config.onChannelOpen?.(remoteId); };
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
      // A tagged flood — either a broadcast, or a directed send() to a peer
      // we have no direct link to. Untagged is a direct message, unchanged.
      if (d && typeof d === "object" && typeof d._relayId === "string") { this._handleRelay(remoteId, d); return; }
      this.config.onMessage?.(remoteId, d);
    };
    // werift exposes inbound as `onMessage` (an Event); browsers use `onmessage`.
    if (ch.onMessage?.subscribe) ch.onMessage.subscribe(onMsg);
    else if (ch.message?.subscribe) ch.message.subscribe(onMsg);
    else ch.onmessage = (ev) => onMsg(ev && typeof ev === "object" && "data" in ev ? ev.data : ev);
  }

  /**
   * A message tagged for the flood overlay — mirrors peer.ts's handleRelay.
   * `_relayId` dedupes so a message reaching us by two paths is only
   * delivered/relayed once; `_hops` bounds how much farther it can travel;
   * `_relayTo`, if present, means only that peer should actually receive
   * it — everyone else on the path still relays it onward. `_from` is who
   * actually sent it, not `fromPeerId`, which is only the last hop.
   */
  _handleRelay(fromPeerId, data) {
    const relayId = data._relayId;
    if (this.seenRelay.has(relayId)) return;
    this.seenRelay.add(relayId);
    if (this.seenRelay.size > SEEN_RELAY_MAX) this.seenRelay.clear();

    const hopsLeft = typeof data._hops === "number" ? data._hops : 0;
    const relayTo = typeof data._relayTo === "string" ? data._relayTo : undefined;
    const from = typeof data._from === "string" ? data._from : fromPeerId;

    const cleaned = { ...data };
    delete cleaned._relayId;
    delete cleaned._hops;
    delete cleaned._from;
    delete cleaned._relayTo;

    this.lastHeardVia.set(from, Date.now());

    if (relayTo === undefined || relayTo === this.peerId) {
      this.config.onMessage?.(from, cleaned);
    }

    if (hopsLeft > 0) {
      const out = { ...cleaned, _relayId: relayId, _hops: hopsLeft - 1, _from: from };
      if (relayTo !== undefined) out._relayTo = relayTo;
      const payload = JSON.stringify(out);
      for (const [peerId, ch] of this.channels) {
        if (peerId === fromPeerId) continue;
        if (this._channelOpen(ch)) { try { ch.send(payload); } catch {} }
      }
    }
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
    // Answering is an attempt too — the sweep and pinNeighbor must not dial a
    // peer we are mid-answer with (see _connecting).
    this.attemptAt.set(fromId, Date.now());
    // Renegotiation on a LIVE connection — e.g. a browser peer started a call and
    // added mic/cam, re-offering on the existing connection. Answer on the existing
    // pc; NEVER tear down a working data channel (the old bug: `_newPC` closes it,
    // so starting a call dropped every agent). Data-only node peers just answer
    // without media; if werift can't renegotiate (glare/unsupported), keep the
    // channel and ignore the offer rather than dropping the peer.
    //
    // CRUCIAL — reconnect vs. renegotiation. A peer that RELOADED its browser keeps
    // the same peerId (sessionStorage) but dials in with a BRAND-NEW ICE session
    // (fresh ice-ufrag). If our old connection to that peerId still shows an "open"
    // channel (the close hasn't been detected yet — racy), answering the fresh offer
    // on the STALE pc never establishes a transport, so the reloaded peer silently
    // never reconnects: no data channel, no name announce (it just shows as a hex
    // id). Only treat an offer as a renegotiation when its ice-ufrag MATCHES the live
    // connection's; a new ufrag means the peer reconnected → rebuild a clean pc.
    const existing = this.connections.get(fromId);
    const sameSession = existing
      && _iceUfrag(existing.remoteDescription?.sdp) !== null
      && _iceUfrag(existing.remoteDescription?.sdp) === _iceUfrag(sdp);
    // Only renegotiate on the live pc when it is actually idle. If we ALSO have an
    // outstanding offer on it (renegotiation glare — both sides re-offered on the
    // same tick, e.g. a call adding media), werift's setRemoteDescription throws
    // "Cannot handle offer in signaling state have-local-offer" (no implicit
    // rollback). Fall through to the glare tiebreak below instead of erroring.
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

    // Perfect-negotiation glare. We AND the far side dialed each other at once —
    // each now holds an outstanding offer. Without arbitration both peers tear
    // down their own offer to answer the other's, both answers land on a pc
    // that's already been replaced, and neither side ever completes — an
    // infinite rebuild that pegs a core on BOTH (seen live: facilitator <->
    // skeptic, two node agents on one host, "serving state" thousands of times).
    // Tiebreak matches peer.ts: the SMALLER peerId yields and answers; the
    // larger keeps its own offer and ignores this one (the far side will answer
    // it). Deterministic, symmetric, needs no extra signalling.
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
  // with EVERY peer — agents included — adding audio/video m-lines to the offer.
  // werift otherwise auto-creates recvonly transceivers, registers SSRC receivers,
  // and then decrypts + parses every inbound RTP packet in pure JS: ~20% of a core
  // per active call PER agent, for media nothing here will ever use (measured live
  // — three co-located agents pegged a machine on one call, RtpHeader/handleRTP/
  // decryptRtp topping the profile). Forcing every media transceiver inactive
  // before we answer makes werift emit a rejected m-line (port 0 / a=inactive), so
  // a compliant peer sends us no RTP at all and the decrypt loop never runs.
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
    // An answer is only meaningful while our own offer is outstanding. Two
    // peers can dial each other at the same moment — glare — and then each
    // receives an answer to an offer it has already replaced, which werift
    // reports as "Cannot handle answer in signaling state". Thrown, that became
    // an error the agent treated as a broken socket and reconnected over,
    // which is a flap caused by a message that only needed ignoring.
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
    // close() is async — it awaits sctpTransport.stop(), which is the step that stops
    // the retransmit timer. Fire-and-forget is fine here, but surface the rejection
    // rather than letting a failed teardown vanish (and leave the association live).
    try { Promise.resolve(pc?.close()).catch((e) => this.config.onError?.(e)); } catch {}
  }
}

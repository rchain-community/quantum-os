# Connection & networking

Detail split out of [CLAUDE.md](../CLAUDE.md). Covers the signaling relay, the
full-mesh model and its single-dialer rule, room capacity, leased peer IDs,
`/ice` diagnostics, the default TURN relay, and the signaling-reconnect /
false leave-join fixes.

---

## Signaling server trust model

The signaling server is an **untrusted relay**:
- Routes SDP/ICE between peers; never sees WebRTC data channel contents (DTLS-encrypted)
- `wsIndex: Map<WebSocket, string>` — binds each socket to its peerId at join; validates `msg.from` on every relay to prevent forgery
- Rate-limited per connection as a **token bucket** — `SIGNAL_RATE_LIMIT` sustained (200/s on the public deployment; code default also 200), `SIGNAL_RATE_BURST` depth (4×). Joining is bursty then quiet — offers plus their ICE candidates arrive in a clump — so a fixed window punished exactly that shape; the sustained rate protects the server, the burst lets a legitimate join land. A server refusal is surfaced into the room (`onSignalingError`) rather than only the console.
- Message size capped at 64 KB (`maxPayload: 65_536`)
- Logs show only last 8 chars of IDs

`GET /` reports the enforced `limit`/`burst` and whether TURN is configured, because a deploy proves the code shipped and proves nothing about the env it shipped into. `scripts/qos-cli/signal-probe.mjs` measures what is really enforced.

## Full mesh with a single-dialer rule

Every browser opens a WebRTC data channel to **every** other peer in the room.
There is no overlay, no relay, no routing — one concept: **a peer is reachable
iff you hold an open data channel to it** (`QOSPeer.hasChannel`). That is what
the roster's `⚠` mark and the status line's "N unreachable" count mean.

**Who dials whom.** For any pair, the peer with the lexicographically-**smaller**
`peerId` is the initiator: it creates the `RTCPeerConnection`, creates the data
channel, and sends the offer. The larger-id peer **only answers**. Because only
one side ever sends an offer for establishment, there is no glare to arbitrate —
the whole class of "both dialled at once, both tore down their own offer to
answer the other's, neither completed" is gone by construction.

- `initiates(peerId)` = `this.peerId < peerId` (`peer.ts`, mirrored in `qospeer.mjs`).
- On the signaling `peers` / `joined` message: dial each peer we're the initiator for and have no open channel to. `onPeerJoined` still fires for **every** peer unfiltered, so the app's roster shows everyone present.
- **`sweep()`** every `SWEEP_MS` (8s): dial any roster peer with no open channel, unless an attempt is already in flight (`connecting()` — a pc `new`/`connecting` with an attempt younger than `ATTEMPT_PATIENCE_MS`, 45s) or its `retryAt` is still in the future. The smaller-id side retries every `RETRY_INTERVAL_MS` (10s); the larger-id side waits an extra `FALLBACK_EXTRA_MS` (15s) before stepping in as a **fallback dialler** — so a peer whose smaller side is dead or on an old build still connects, without both sides racing in the common case.
- **Perfect-negotiation glare handling is kept** (`makingOffer` map + `polite = smaller id`), but it is now only reachable via **media renegotiation** (a call adds tracks — either side may re-offer) or a mixed-build peer that still both-dials. It is the textbook WebRTC pattern, ~15 lines, and was never itself the problem — the problem was its interaction with a retry sweep and a bounded-degree overlay that no longer exist.
- **`redial(peerId)`** — a public "connect now" for the `/conn` diagnostic and `reportUnreachable`. Dials regardless of which side is the normal initiator; a person asking for it wants the link, not the etiquette.

**Why this replaced the ring + skip-link overlay.** The overlay existed to keep a
join's dial burst under the signaling server's rate limit. That limit is now
200/s sustained / 800 burst on the deployed server — comfortably more than a
15-peer join costs (~14 offers + a few ICE candidates each). The overlay's cost
was that its neighbor set was computed from each peer's own view of the roster,
which diverges transiently during joins and flaps, so needed links were never
dialled and a flood relay papered over it inconsistently — "randomly connected
or not", reported live. Full mesh to ~15 is simple and every pair is either
connected or visibly not.

## How many people a room holds

`ROOM_HOLDS = 15` in `app.ts`. Nothing is refused at the door — the number is
the point at which a browser mesh stops sustaining every channel, and what
matters is that the room **says so** (`⚠` on any peer with no channel, counted
in the status line, and one `reportUnreachable` line per peer after
`HANDSHAKE_GRACE_MS`). Five is where a group actually thinks together, so the
human limit binds first. Past ~15 needs a different topology (an SFU for media,
a partial-mesh/gossip overlay for data) — not built; split the room or run your
own signaling server.

## An identity that survives a phone discarding the tab

`peerId` lived in `sessionStorage` alone: per-tab, which is right, but a mobile
browser throws sessionStorage away when it evicts a backgrounded tab. So a phone
whose screen locked rejoined as a *new peer* every time, and the room filled
with ghosts of its previous incarnations.

So an id is **leased** (`claimPeerId` in `peer.ts`): a live tab refreshes
`qos-peer-lease:<id>` in localStorage every 5s, and a load with no sessionStorage
id reclaims any lease older than 20s rather than minting. Two tabs open at once
still differ — both leases are fresh, and only an expired one can be taken.

**The lease is scoped to the dyncap anchor.** It records `{at, anchor}`, and
`claimPeerId` reclaims a stale lease only if its `anchor` matches this browser's
current one (`myAnchor()` reads `qos-dyncap-state` directly). Without this, an
identity that *changed* — a `/login` recovery, a partial storage clear — would
inherit a `peerId` that other peers TOFU-pinned to the **old** anchor, and every
signed `name`/`lemma`/… from it is refused as `anchor-mismatch`. `test/peer.test.mjs`
covers both directions.

**`name` survives a dyncap refusal (`app.ts`, inbound `name` handler).** A
`lemma`/`sync-*`/`retract` envelope that fails `verifyDyncapIfPresent` is dropped.
A **`name`** envelope is not — the receiver applies the claimed name with a ` ⚠`
suffix and posts one warning line, while still skipping `reconcileGroups` (the
part that *trusts* the chain). A display name is cosmetic; refusing to render it
left a peer whose chain went contested as a permanent hex id, which *hid* the
impersonation instead of flagging it. SECURITY.md records the reasoning.

## Whether two peers can connect at all (`/ice`)

Before any of this: **a browser may have no WebRTC**. `RTCPeerConnection` missing
is not a network problem and no relay, retry or reload touches it. `webrtcMissing()`
is checked in `connect()` and names the three causes: a privacy extension or
shield, WebRTC disabled in settings, or an in-app browser.

STUN only tells each side what its public address looks like; the connection is
still made **directly**. Two peers behind symmetric NAT — a corporate network,
mobile CGNAT — have no address pair that works, so the handshake fails
**permanently** and the retry sweep cannot help. Only a TURN relay crosses that.

`peer.ts`'s own `DEFAULT_ICE` constant is STUN alone — the app layer supplies a
relay by default (see below). `/ice list · auto · test · stun · turn · reset`
is where a relay is chosen or turned off — **excluded from the qlf broadcast**,
because a `/ice turn` entry carries a username and password. **`/ice test`**
gathers candidates (including the auto-fetched relay) and names what the network
allows — `host` / `srflx` / `relay` — the difference between "this pair is slow"
and "this pair cannot connect". The result is one fenced block kept on the device
(`qos-ice-last`), re-readable with `/ice last`.

## Calls must work across networks — a default TURN relay (quantum-os#126)

A data-channel message needs a direct ICE pair between the two peers; so does a
call, and a `MediaStreamTrack` cannot be relayed any other way. Without a relay,
a call between two peers who can't form a direct pair (symmetric NAT, mobile
CGNAT, a NAT'd container) produced **no video at all, silently**.

**The fix ships a default relay, kept overridable.** `TURN_KEY_ID` /
`TURN_KEY_API_TOKEN` (Cloudflare Realtime's TURN Service) are environment
variables on the **signaling** deployment — never in `render.yaml`, never
shipped to the browser. `packages/signaling/src/turn.ts` mints a short-lived
credential and `GET /turn` on the signaling HTTP server hands back
`{iceServers: [...]}`. The master API token never leaves the signaling process.

- **Browser** (`app.ts` `fetchAutoTurn`): `connect()` awaits a 4s-capped fetch of `<signalingOrigin>/turn` and merges the result into `iceServers` before constructing `QOSPeer`. Best-effort — every failure falls back to STUN-only, never throws, never hangs `connect()`.
- **`/ice auto on|off`** (default on, `qos-ice-auto`) is the opt-out. `/ice turn ...` substitutes your own.
- **Agents** (`qospeer.mjs` `_loadAutoTurn`/`_iceServers`) get the same fetch — a cross-network agent needs a relay on at least one side to form its direct links. Skipped when the caller passed explicit `iceServers` (tests). `turn-relay.selftest.mjs` covers merge / empty / unreachable / explicit-override.
- **A cross-network call that still can't cross is surfaced** (`calls.ts` `checkMediaReach` / `CallHost.mediaBlocked`): ~12s and ~35s after a call starts, any non-agent room peer whose direct connection has `failed`/`disconnected` (or, on the later strict pass, is still `checking`/`connecting`) gets one chat line naming them — "can't get the call … try `/ice turn …` or `/ice test`". Named once per call; the warned set clears on `end()`.
- **Render can't host TURN itself** — it exposes one HTTP(S) port per service; TURN needs raw UDP. Cloudflare Realtime was chosen because it needs no server. A paid Render tier for the **signaling** service removes free-tier sleep-on-idle, the actual cause of the `signaling dropped (1006)` reconnect churn.

## Signaling reconnect / false peer left-right

When the signaling WebSocket drops and reconnects (Render sleep, network blip):

- **Skip peers whose data channel is still open** on the `peers` list after a reconnect — don't tear down a working connection.
- **Reconnect = rebuild, not renegotiate (the reload fix)** — `peer.ts` **and** `qospeer.mjs` `handleOffer`: a reload keeps the peerId (sessionStorage) but dials in with a **fresh ICE session**. Answering the fresh offer *as a renegotiation on the dead pc* never resurfaces the peer's **new data channel** (`ondatachannel` doesn't re-fire on renegotiation), so the reloaded peer connects-but-stays-silent. Fix: compare the offer's **`ice-ufrag`** to the live connection's — same ufrag = a genuine renegotiation (keep the pc), different ufrag = the peer reconnected ⟹ **rebuild a clean pc**.
- **Presence eviction (stale-room fix)**: an *ungraceful* drop sends no `leave` and the connection often never reaches `"failed"`. So `declarePeerGone` fires `onPeerLeft` on **data-channel `onclose`** (the reliable signal for a clean tab-close); `"disconnected"` starts an 8s grace timer and evicts only if it doesn't recover. `declarePeerGone` is idempotent.
- **An ICE `"failed"` to a peer still in the room is *unreachable*, not *gone*.** `"failed"` means *no candidate pair worked* — a cross-network peer with no working TURN never completes a **direct** handshake, which is a different fact from "they left". If `roster.has(peerId)` → `cleanup()` the dead pc so the sweep redials, back `retryAt` off one cycle, and **return without `onPeerLeft`**; `renderPeers` marks them `⚠`. The authoritative "they left" is the signaling `left` message; the data-channel `onclose` path still declares gone for a peer we held a channel to. `test/peer.test.mjs` covers both directions.
- **`createPeerConnection` detaches the stale connection's handlers before closing it**, because closing fires them and they declare the peer gone — so every retry used to produce a `left` then a `joined`, which reads as peers flapping while nothing happened.
- **The sweep never redials an attempt already in flight** (`connecting()`): redialling sends a fresh offer with a new ICE ufrag, so the far side rebuilds and the negotiation in progress is discarded — a slow path (mobile) would be reset before it could ever finish.
- **`qospeer.mjs` disconnected-teardown (the pegged-CPU fix)** — **werift never escalates `"disconnected"` to `"failed"`** (no consent-freshness timer). `_newPC` cleaned up only on `"failed"`, so a peer that vanished silently parked a connection in `"disconnected"` forever: `pc.close()` was never called ⟹ `sctpTransport.stop()` never ran ⟹ the SCTP association retransmitted its unacked queue at full speed through pure-JS DTLS — **one zombie peer pegs a core**. Fix: also tear down on `"disconnected"` after `DISCONNECT_GRACE_MS` (30s), re-checking the same `pc` is still stuck. **Diagnosing a recurrence:** compare CPU against UDP throughput (`/proc/net/snmp` `Udp: OutDatagrams`) — high CPU + ~0 pkt/s means an orphaned association.
- **`qospeer.mjs` rejects call media (`_rejectMedia`)** — a node agent is data-only, but a browser starting a call renegotiates with **every** peer, putting `m=audio`/`m=video` in the offer. werift's default is to auto-create `recvonly` transceivers and **decrypt + parse every inbound RTP packet in pure JS**, pegging a core per agent per call. Fix: `_handleOffer` calls `_rejectMedia(pc)` after `setRemoteDescription`, walking `pc.getTransceivers()` and `setDirection("inactive")` on every audio/video one — werift then emits a rejected m-line and a compliant peer sends no RTP. `media-reject.selftest.mjs` covers it.
- **`werift-patched.mjs` — the per-ICE-candidate SDP-rebuild burn (issue #125).** werift rebuilds the entire offer SDP on every inbound ICE candidate, and each rebuild calls `RTCCertificate.getFingerprints()`, which re-parses the cert PEM and re-hashes it (~1.5 ms). `werift-patched.mjs` memoizes `getFingerprints()` on the instance, keyed on `certPem`; `qospeer.mjs` imports werift through this wrapper. `werift-patched.selftest.mjs` guards against a werift bump.
- **`room-memory.mjs` `serveStateTo` skips an unchanged re-serve (`_servedSig`).** A per-peer signature of everything the serve would send is compared; an identical re-serve is dropped silently. `forgetPeer(id)` (from `onPeerLeft`) drops the maps on departure.
- **Async command output belongs to a room (`inRoom`)**: `activeRoom` is aliased state that inbound callbacks swap while they work, so a command answering after an `await` can append its lines to the wrong room. `inRoom(ctx, fn)` captures the room at command time and restores after; `/ice test` and `/rholang explain` use it.
- **`app.ts`**: `onPeerLeft` is debounced 6 seconds (`pendingLeaves`) and is idempotent. A rejoin within the window suppresses both "left" and "joined".
- **Background-tab recovery**: `peer.ts` `wake()` (reconnect now, reset the throttled backoff) is called on `visibilitychange`/`focus`/`pageshow`/`online`. `app.ts` adds a peer to the roster on **`onChannelOpen`** too (a remote-initiated peer — e.g. an agent that dialed us — shows up). Agents are flagged **🤖** via `peerAgents`. **Sticky identity caches** (`lastKnownNames`, `peerAgents`) are per-`RoomContext` and **never cleared on leave** — a flapping AI daemon keeps its name and badge across reconnect churn (a departed peer's stale entry never renders — the roster only badges ids still in `peers`).

# qos-cli — headless QuantumOS room peer

A standalone Node script that joins a QuantumOS room by its capability token,
connects to the live peers over WebRTC, and broadcasts a chat message — then
exits. Useful for announcements, bots, or scripting from outside the browser.

It speaks the exact protocol of `packages/browser/src/peer.ts`:

- signaling JSON over WebSocket: `join` / `offer` / `answer` / `ice` / `leave`
- data channel label `"qos"`
- chat envelope `{ kind: "chat", text }` (plus an optional `{ kind: "name", name }`)
- peer identity is a freshly generated `cap:peer:…` ZFA token (ported from `zfa.ts`)

> **This directory is intentionally outside the pnpm workspace** (`packages/*`),
> so it does not affect the repo's typecheck or CI. Install its deps locally.

## The one thing to understand first

QuantumOS rooms are **pure peer-to-peer**. The signaling server only routes
WebRTC handshakes — there is **no server-side room and no message history**. A
broadcast reaches only the peers connected *at that moment*. **If nobody is in
the room, the message goes nowhere.** So to announce something, a human (or
another peer) must have the room open when you run this.

## Install

```bash
cd scripts/qos-cli
npm install          # pulls ws + werift (werift = pure-TS headless WebRTC)
```

## Use

```bash
# Announce to the public room (someone must be in it):
node qos-cli.mjs \
  --room "https://rchain-community.github.io/quantum-os/#room=cap%3Aroom%3A05214747236101414325074505234721" \
  --name "release-bot" \
  --message "QLF v1.6.0 released — https://github.com/rchain-community/quantum-logical-framework/releases/tag/v1.6.0"

# A bare cap works too:
node qos-cli.mjs --room cap:room:0521… -m "hello room"

# Listen and print room chat (Ctrl-C to exit):
node qos-cli.mjs --room cap:room:0521… --listen
```

Options: `--room` (cap or URL, required), `--message`/`-m`, `--name`,
`--signal <url>` (default `wss://quantum-os-signaling.onrender.com`),
`--wait <ms>` (give up if no peer reached, default 15000), `--linger <ms>`
(stay after delivery, default 2000), `--listen`, `--help`.

Exit codes: `0` delivered (or listened), `1` error, `2` no peer reached in time.

## Persistent "memory peer" daemon (`qos-daemon.mjs`)

The room has no server and no history — when every browser leaves, its lemmas,
currencies, and chat are gone. The daemon fixes that: it stays connected (with
auto-reconnect), **persists the room's public state + transcript to disk**, and
**re-serves that state to every peer who joins** (`name` + `sync-lemmas` +
`sync-currencies`, all dyncap-signed). It holds a **stable signed identity**
(`cap:peer` + dyncap anchor) across restarts, so peers TOFU-pin it as one
continuous peer.

```bash
node qos-daemon.mjs \
  --room "https://rchain-community.github.io/quantum-os/#room=cap%3Aroom%3A05214747236101414325074505234721" \
  --name "memory" --state ./.qos-state
```

Options: `--room` (cap or URL, required), `--name` (default `qos-memory`),
`--signal <url>`, `--state <dir>` (default `./.qos-state`, gitignored),
`--lemma <name>` (seed a durable lemma the daemon holds + re-serves to
joiners; ZFA twists minted automatically; repeatable), `--verbose`.
Runs until Ctrl-C, then flushes state and leaves.

Seeding a durable announcement (chat is ephemeral; a lemma persists and is
re-served to late joiners):

```bash
node qos-daemon.mjs --room "<…>" --name memory \
  --lemma "QLF v1.6.0 released — …/releases/tag/v1.6.0"
```

State layout (`--state` dir):

```
identity.json                 # { peerId, name, dyncap:{seed,anchor,seqByRoom} } — cross-room
rooms/<roomhex>/lemmas.json   # { name: { twists, who, cap?, dyncap? } }
rooms/<roomhex>/currencies.json
rooms/<roomhex>/chains.json   # dyncap TOFU pins (fork detection survives restart)
rooms/<roomhex>/series.json   # note terms-series { "USD~hash": { baseCurrency, termsHash, terms, issuer, dyncap? } }
rooms/<roomhex>/groups.json   # governance groups { groupId: { members (each with anchor?), delegations, topicDelegations, issues, treasury?, kudos?, vaults? } }
rooms/<roomhex>/retracted.json     # canonical lemma names + "group:<id>" retracted by their owner (tombstones)
rooms/<roomhex>/transcript.jsonl   # one JSON line per inbound message
```

Ingest rules mirror the browser: lemma names are **canonicalized** (trim +
collapse inner whitespace, matching `@[multi word]` names); lemmas are
first-write-wins by canonical name and immutable (a different-twists redeclare is
rejected); currencies are FWW by token; both are ZFA-validated before storing.
The daemon also honors a **`retract`** for a lemma from its **author** (the
sender's dyncap anchor must match the lemma's stored anchor): it drops the lemma,
tombstones it in `retracted.json`, and stops re-serving it — so an always-on
memory peer can't resurrect a lemma the author removed. **Note terms-series**
(`note-series`) are persisted and re-served via `sync-series`: a declaration is
accepted only when its terms hash to the series stamp (self-verifying), and a
live `note-series` additionally requires the sender to be the currency's issuer
(verified anchor). **Governance groups** are persisted and re-served via
`sync-gov`: the daemon applies the same group mutation envelopes the browser sends
(`group-open` / `group-member` admin-gated / `gov-delegate` self-signed /
`group-issue` / `group-vote` / `group-meta`), and honors a creator's group
disband (`retract` → tombstone), so groups + delegations + treasury/kudos
currencies survive when every browser leaves. It also ingests **`gov-vault`**
(a member's password-encrypted identity, keyed by a public handle) and carries
`vaults` through `sync-gov`, so a member can recover their identity with
`/login <handle>` after every browser has left — first-write-wins by handle,
same-anchor overwrite, ciphertext the daemon can't read. Polls and the per-group inbox
(`group-msg`) are ephemeral and not persisted. Held notes/receipts are never
gossiped, so the daemon never stores private bearer value.

**To reset the room's remembered state**, delete the `--state` directory.

## Push a lemma to already-connected peers (`pushlemma.mjs`)

The daemon hands lemmas to a peer via `sync-lemmas` only when that peer's data
channel **opens** (join/refresh). A lemma seeded or learned *after* a peer
connected is therefore not pushed to it — and restarting the daemon does not
help, because it keeps a stable `cap:peer:…` identity, so an already-connected
browser treats it as the same open peer and never re-handshakes.

`pushlemma.mjs` closes that gap: it joins from a **fresh** peerId (which every
browser will handshake with) and broadcasts the lemma live as a `lemma` envelope
— the same kind a browser emits on `/lemma` — so connected peers ingest it
immediately.

```bash
# Forward a lemma the daemon already holds (read from its state file):
node pushlemma.mjs --room "<cap|url>" --select "<lemma-name>"
node pushlemma.mjs --room "<cap|url>" --cap-prefix cap:QLFv170

# Or broadcast an ad-hoc lemma (validated for ZFA before sending):
node pushlemma.mjs --room "<cap|url>" --lemma-name foo --twists "^v<>/\+-"
```

It stays connected for `--linger` ms (default 12000) to reach peers, then leaves.

## Bridge rooms — share inputs/outputs across perspectives (`bridge.mjs`)

A room is a Markov blanket: peers inside share a closure, peers outside see
nothing. `bridge.mjs` is one perspective that stands in **two or more rooms at
once** and relays each room's channel outputs as the others' inputs — the
QuantumOS realization of ER=EPR at the collaboration layer (a member of both
rooms *is* the shared closure between them). See [`../../Room_Bridges.md`](../../Room_Bridges.md).

```bash
# Every channel message in one room becomes an input to the other:
node bridge.mjs --room "cap:room:…A…" --room "cap:room:…B…" --name team-bridge

# Restrict to named channels, and also relay chat:
node bridge.mjs --room <A> --room <B> --channel decisions --channel alerts --chat

# Also bridge durable state — lemmas and governance/groups:
node bridge.mjs --room <A> --room <B> --lemmas --gov

# Hub over three rooms:
node bridge.mjs --room <A> --room <B> --room <C> --channel status
```

Rooms may be bare caps or full app URLs; at least two distinct rooms are
required. Chat/channel messages are prefixed with their origin room label
(`[R1:abc123] …`) so provenance is never lost. With **`--lemmas`** the bridge
relays published lemmas and imports each room's existing set (`sync-lemmas`);
with **`--gov`** it relays group/governance mutations and imports existing
groups (`sync-gov`). These signed envelopes are relayed **verbatim** so the
original signer's dyncap chain carries through (receivers accept forwarded
entries on the forwarder's trust). Loops are prevented by a per-bridge tag plus
a `--max-hops` counter (default 1) and a durable per-item dedupe for state.
Options: `--room` (repeatable), `--channel <name>` (repeatable; default all),
`--chat`, `--lemmas`, `--gov`, `--name`, `--signal <url>`, `--max-hops <n>`.
Like the daemon, it only relays what is live — run it long-lived for a standing
link (it auto-reconnects), and pair it with a memory daemon per room for
durable cross-room state. See [`../../Room_Bridges.md`](../../Room_Bridges.md).

## Verify offline (no network, no deps)

```bash
node selftest.mjs        # ZFA: 200 peer caps + closure facts + parseTwists
node dyncap.selftest.mjs # dyncap: sign→verify chain, canonicalization, fork detection, state round-trip
```

The dyncap suite proves the signing port matches the browser byte-for-byte
(so the daemon's signatures verify there).

```bash
npm install && node loopback.mjs            # werift↔werift WebRTC round-trip over a local relay
node media-reject.selftest.mjs              # a data-only agent rejects a call's audio/video, keeps the data channel
node turn-relay.selftest.mjs                # the default-relay auto-fetch (GET /turn) merges, falls back, and never overrides an explicit config
node werift-patched.selftest.mjs            # RTCCertificate.getFingerprints() is memoized (issue #125) and still returns the right value
```

The loopback test spins an in-process signaling relay and two peers that
connect and exchange a chat — exercising the full handshake + data channel
locally (needs `ws` + `werift`).

`media-reject.selftest.mjs` drives an inbound offer that carries audio + video
(what a browser sends when someone starts a call) and asserts the agent answers
with every media m-line rejected — so werift never spins up an RTP receiver and
never burns a core decrypting call media it will never use.

`turn-relay.selftest.mjs` drives `QOSPeer._loadAutoTurn`/`_iceServers` against a
stand-in HTTP server (not the real signaling server, not Cloudflare) — see
CLAUDE.md "Calls must work across networks" for why an agent needs this too:
the flood relay only works if some agent actually holds a direct link to both
sides of a NAT boundary.

```bash
node optimize-demo.mjs   # collective-annealing demo on a classic problem (TSP)
```

Runs the collective-optimization loop (generate → score → anneal → converge) on a
small Travelling Salesman instance and checks the result against the brute-force
optimum — the same loop a room runs collectively. No deps. See
[`OptimizationDemo.md`](../../OptimizationDemo.md) and
[`Collective_Optimization.md`](../../Collective_Optimization.md).

## Verified

- **Offline:** ZFA layer, dyncap sign/verify, and `loopback.mjs` (werift↔werift
  data channel) all pass.
- **Live (2026-06-08):** the daemon connected to the public room through the
  Render signaling server, established a WebRTC data channel **with a browser
  peer**, received its `name` + `sync-lemmas`, and persisted the room's lemmas
  to `--state`. werift↔browser interop confirmed. Lemmas that are count-balanced
  but not Pauli-closed are skipped on sync — identical to the browser's own
  `sync-lemmas` gate (`achievesZfa` required), so the daemon mirrors the room
  faithfully.

## Agents (facilitator, scribe, greeter …)

`agent.mjs` is a sibling daemon that joins a room as a **full member** (stable
`cap:peer` + dyncap identity) and posts **measured** nudges according to its
`--role` — effectively the runtime of
[`Room_Best_Practices.md`](../../Room_Best_Practices.md). It has no special
authority (it only posts `chat`); the group decides, and can `/gov trust` it up
or `/gov censure` it down like any peer — so its disruption level is governed by
the room, not hard-coded.

```bash
node agent.mjs --room <cap:room:… | room-URL> [--role facilitator] [--name <s>] \
  [--budget 4] [--silent-min 6] [--quiet | --active] \
  [--ai] [--ai-backend api|claude-code] [--state ./.qos-agent]
```

**Run the persistent room** (detached, on a Claude subscription): `bash run-agents.sh`
launches `facilitator` and `skeptic` on the `claude-code` backend with stable per-role
identities. The **room's memory rides with the first role** (`--persist`), so lemmas,
currencies, note terms-series, gov groups, dyncap chains and the transcript are kept on
disk and re-served to every joiner — room state survives when every browser leaves —
without spending a peer on a separate daemon. `NO_MEMORY=1` turns it off, `PERSIST_DIR`
moves the store. Logs/pids under `.agents/`; `bash stop-agents.sh` stops everything with
a pidfile.

Why those two roles, and not `scribe`: a scribe's duties are a strict subset of the
facilitator's (compare `duties` in `agent-roles.mjs` — scribe sets nothing the
facilitator does not), so it needs no peer of its own, and a facilitator carrying
`--persist` is literally the one keeping the record. `skeptic` is separate because it
is the only role with `verify` — which predicate a history actually passed.

`qos-daemon.mjs` still runs the same duty standalone, sharing the implementation in
`room-memory.mjs`. Prefer it when durability should not depend on an agent that also
talks: it needs no Claude subscription and fails only if its process dies. Vary the agents by passing a room then roles
(`bash run-agents.sh <room> facilitator skeptic`); `NO_MEMORY=1 bash run-agents.sh`
skips the daemon. (nohup'd, so they survive closing the terminal; use tmux/screen or a
service to survive logout/reboot.)

> **How many agents a room can hold.** The free signaling server rate-limits, and the
> limit covers the WebRTC offer/answer/ICE exchange, not just joining. Past a handful
> of peers, handshakes stop completing: everyone still shows up in the room and no data
> channel opens, which from a browser is indistinguishable from the agents never
> starting. Measured on that server, same room, same code, counting *total peers in
> the room* — an observer joining to watch counts as one: **7 → 0 of 6** channels
> open, **5 → 1 of 4**, **4 → 3 of 3**. Four is the most that has been seen to work;
> the default set (facilitator, memory, one browser) is three. Hence one role by
> default and a 15s stagger (`STAGGER=n` to change it); `NO_MEMORY=1` frees a slot.
> Add roles deliberately, and run your own signaling server if you want a full cast —
> that removes the ceiling.

**Running your own signaling server** (no ceiling, and nothing leaves the machine):

```bash
# 1. the server — the raised limit is the whole point
cd packages/signaling && npx tsc && SIGNAL_RATE_LIMIT=200 PORT=4444 node dist/index.js

# 2. agents — Node has no mixed-content rule, so plain ws is fine
bash run-agents.sh <room> facilitator scribe skeptic   # then --signal per agent

# 3. browser — the vite dev server proxies /signal, so this is wss:// on the
#    origin the page already loaded from, with no second certificate
open "https://<host>:5173/quantum-os/?signal=wss://<host>:5173/signal#room=<cap>"
```

`?signal=` presets the sidebar's signaling field, so the whole setup is one link.
Measured this way: **6 peers in the room → 5 of 5 channels open**, the same room
size that opened 0 of 6 against the public server.

The public server remains the default and the supported path. Run your own only if
you actually need a bigger cast, and remember agents pointed at it are invisible to
anyone on the public one — mixing the two silently splits the room.

Note this only works from the vite dev server. A page served from GitHub Pages is
a different origin and cannot proxy to your machine, so a local signaling server
needs a certificate of its own there.

**Roles** (`agent-roles.mjs`): `facilitator` (greet, name-prompts, participation
nudges, dis/agreement synthesis), `scribe` (quietly tracks decisions, offers to
record them as `/lemma`), `greeter` (welcomes newcomers, helps set a name), and
`skeptic` (surfaces the unexamined assumption and asks for evidence before the group
closes — the Room Best Practices Skeptic). Each role picks a default name, a command
prefix (`/facil`, `/scribe`, `/greeter`, `/skeptic`), an AI persona, and which
proactive duties it performs. `facilitator.mjs` remains as a
thin back-compat shim (`--role facilitator`, historical `--state ./.qos-facilitator`).

**Multiple agents in one room.** Run several with different `--role` (and distinct
`--state` dirs). They tag their `name` envelope with their role, so they recognize
each other and (a) **elect a single lead** per shared proactive duty — only the
lowest-`peerId` agent that performs a duty acts, so N agents don't all greet — and
(b) count their posts **collectively** against the human fair-share, so adding
agents can't inflate the budget. Direct replies (`/facil`, `/<role> ask`) still
come from each agent for itself.

**The skeptic's verifier duty.** The room's `achieves_zfa` conjoins Pauli closure
with *aggregate* count balance, where QLF's `is_zfa` wants every conjugate pair
balanced on its own. The aggregate predicate over-accepts — at length 6 it admits
20,480 histories against QLF's 5,120 — so a history can read "ZFA ✓" in the room
and not be a QLF closure. A `--role skeptic` agent checks both predicates on every
inbound `lemma` and `/qlf-action` / `/zfa-check` history and, when only the weaker
one passes, says so once: the signed action vector, which conjugate pairs are off,
and how wide the gap is at that length. Histories that pass both, or fail both, get
no comment. Backed by `crates/zfa-core/tests/data/census_inventory.json`.

**Trust-governed membership.** An agent is an ordinary trust-weighted member: the
room governs its voice through the *same* liquid-trust primitives as humans
(`gov.mjs` is a faithful port of the browser's `trustLevels`). It ingests
`group-open` / `group-member` / `gov-trust` / `gov-censure` (and `sync-gov`) and
computes its **own standing**, then applies the rule *operate one level below your
actual rating, at full power for that capped level*: a rated agent posts up to
`min(configured budget, trustLevel)` per window — exactly one rung below a same-rated
human's weight `1 + level` — and **stands down** (posts nothing, direct replies only)
if a ⅔ censure quorum discredits it. With no ratings in its groups it runs at the
configured `--budget` (back-compat). `/<role> trust` reports its standing and its
`peerId` (so an admin can `/gov member add <peerId>` then `/gov trust`). Ingesting
unverified gov envelopes only ever *throttles* the agent's own voice (never exceeds
the operator's `--budget`), and the ⅔ quorum blocks a lone griefer from muting it.
Agents are **rated/governed, not raters** — they don't autonomously `/gov trust` or
`/gov censure` humans.

**Telling it's there / commands.** Because it's mostly silent, say `/facil` (or
"anyone here?", or just "hi") and it replies — that's how you confirm it's
present. `/facil help` lists what it does; `/facil ask <question>` gets a brief AI
answer about the room, facilitation, or decisions (needs `--ai`); `/facil optimize
<objective + constraints>` facilitates an annealing-style optimization round —
proposes candidates and the next `/estimate`/`/poll` step (needs `--ai`; see
[`Collective_Optimization.md`](../../Collective_Optimization.md)); `/facil chair
<topic>` chairs a structured deliberation (needs `--ai`; see below); `/facil health`
reports diagnostics for a long-running daemon — uptime, RSS, CPU, signaling/channel
state, present peers, posts used against the budget, trust standing, and the last
error. CPU is given both as a lifetime average and as a delta since the previous
check, because a lifetime average hides a runaway; `/facil list [n]` dumps the
room's screen history the agent has seen — chat lines and `/command → result`
lines, oldest first, `n` in 1..500 (default 25) — as a 1:1 answer to the asker,
for a peer whose own browser can't scroll back far enough or who joined late (the
agent's own `/facil …` control chatter is left out); `/facil off` /
`/facil on` mute and unmute it at runtime. These replies *answer a request*, so they're responsive
(rate-limited only by a short per-command cooldown) and work even while muted.

**Chaired deliberation (`/facil chair <topic>`, needs `--ai`).** The facilitator
becomes the room's **single neutral chair** and walks the group through six phases —
**define → alternatives → evaluate → disagreements → agreements → closure** — posting
a short neutral synthesis at each step and recording a **decision of record** at the
end. Steer it with `/facil next` (a *participant readiness signal* — anyone can send it;
the one chair performs the transition), `/facil back` (reopen the previous phase),
`/facil close` (jump to closure), and `/facil cancel`. `/facil status` shows the current
phase. The closure receipt is written under
`<state>/rooms/<room>/deliberations/<ts>-<slug>.json` (with a `deliberations.json`
index); `/lemma` it to enter the decision as a room decision of record. **One leader by
design:** Jim's EIES research found a computer leader *and* a human leader at once
stymies consensus, so the chair is the single leader for the session — don't run it on
top of a separately human-led topic. It follows best-practice facilitation (neutral
framing, equal airtime, surface disagreement before converging).

**Many facilitators, each speaks only for itself.** A room may have more than one
facilitator (or none) — `/facil` is broadcast, so each present facilitator replies
on its own. The browser does **not** run facilitation and does not vouch for any
facilitator; it only relays the command, and the `/help facil` text describes the
*relay*, not any facilitator's behaviour. Trust a facilitator's **self-description**
(its `/facil help` / `/facil ask` reply, attributed to its signed `name`/identity),
and judge each by its own replies — the AdvisorSystem prompt likewise tells the
daemon to describe only itself.

Deterministic behaviours (no AI):

- **Greets** new members once each (after a short grace) and **prompts the
  nameless** to set a `/name`. A greet held by the throttle re-queues (bounded).
- **Participation** (Room_Best_Practices Rules 6 & 12): solicits the silent
  quarter, gently rebalances a dominator.
- **Surfaces (dis)agreement** from `state-discrepancy` consensus broadcasts —
  names a contested split, or offers to record a converged value.

**AI advisor (`--ai`, opt-in).** With `--ai`, a pluggable advisor
([`facilitator-advisor.mjs`](facilitator-advisor.mjs)) adds two judgment behaviours —
*stimulate* (re-engage after a lull, invite the quieter voices) and *disagreement →
agreement* (name the crux + a path forward) — plus the `/facil ask`, `/facil optimize`,
and `/facil chair` flows. It is
**advisory only**: it proposes a nudge that the same throttle gates, and is called
*only when a post would be allowed*, so usage stays bounded. The daemon is fully
functional without it. Two backends (`--ai-backend`):

- **`api`** (default) — Anthropic Messages API via `fetch` (no SDK dep), key from
  `ANTHROPIC_API_KEY`; pay-as-you-go API credits.
- **`claude-code`** — shells out to the local `claude` CLI in print mode, using your
  **Claude subscription** (Pro/Max) instead of API credits. Requires the `claude` CLI
  installed and logged in (`claude` once interactively to authenticate). No key needed:
  `node facilitator.mjs --room <…> --ai --ai-backend claude-code`.

**Measured disruption** is enforced by a post budget (`--budget` per 5-min
window), a minimum gap between posts, per-behaviour cooldowns, a fair-share check
so it never out-talks the humans in an active thread, and quiet-by-default.
`--quiet` / `--active` shift the whole policy. Stable identity + who-we've-greeted
persist under `--state`.

## Status / caveats

- **ZFA capability layer: tested** (`selftest.mjs`, all pass). Faithful port of
  the `zfa.ts` pure-TS fallback.
- **WebRTC interop: not yet exercised in CI / offline.** It requires a live
  browser peer in the room plus outbound network (STUN + the Render signaling
  server). `werift`'s event API has shifted across versions; the script guards
  both the `.subscribe(...)` and browser-compat (`.onopen`/`onicecandidate`)
  shapes, but if a method is missing on your installed `werift`, that's the
  first place to look. Pinned to `werift ^0.20`.
- **Legacy room token.** The published public-room cap
  `cap:room:05214747236101414325074505234721` predates the v0.17 Pauli-closure
  rule, so it fails `validateCapability` — exactly like the browser, this script
  only **warns** and proceeds (the cap is still a valid rendezvous id).
- Trust model unchanged: possessing the room cap **is** authorization; the
  signaling server is an untrusted relay; data channels are DTLS-encrypted.

## RChain capability macros — the `/rholang` agent (`rholang-agent.mjs`)

The `/rholang` macro agent joins the room and turns chat messages into RChain capability
operations. It maps macro requests to the rchain-rust system contracts and shares
the results back into the room chat:

```bash
node rholang-agent.mjs --room <cap:room:… | room-URL> [--name rholang]
```

While connected, any peer types in the room chat:

- `/rholang macros` — list the approved macro library.
- `/rholang macro <name> <args…>` — the bare form, when the whole program is one macro.
- `/rholang eval|deploy <rholang…>` — expand the `%name(…)` call sites in a program.

**The body is rholang.** Macro call sites are written `%name(arg, …)` and expand
in place inside an ordinary program, one line or many:

```
/rholang eval
new ret in {
  %ballot("Q4 budget", ["ship auth", "pay down debt"]) |
  %directory("Q4 notes")
}
```

The rholang is not parsed — the scanner finds call sites (skipping string
literals and comments, balancing brackets) and passes every other byte through
as written. Errors never abort: each carries its line, and a failed site is left
exactly as typed.

**Read macros are answered by the agent** (locally, via the ZFA engine) and the
result is broadcast to the room:

- `zfa 01` → `zfa(01) → ZFA true (pauli-closed true)`
- `verify cap:room:…` → `verify(cap:room:…) → valid`

**Write macros return a human-readable rholang preview** for the requestor to
review and sign *client-side* (the agent never holds keys — zero-trust):

- proofs — `%grant(twists)`, `%fuse(subject, predicate)`
- group decisions — `%trust(…)`, `%weights(…)`, `%tally(…)`, `%censure(…)`,
  `%ballot(issue, options)`, `%delegate(to)`
- bearer capabilities — `%issuer(currency)`, `%note(authority, amount)`,
  `%redeem(…)`, `%directory(name)`, `%mailbox(name)`, `%group(name)`,
  `%transfer(amount, to)`
- structural patterns — `%swap(a, b, toA, toB)`, `%philosophers([names])`,
  `%multisig(nonce, proposal, quorum)`

Macros are **typed templates**, and the registry lives in
[`packages/browser/src/rholang-macros.js`](../../packages/browser/src/rholang-macros.js) —
**one source shared with the browser**, so the rholang posted in chat is the
rholang the browser signs. `rholang-macros.mjs` is a thin binding that supplies
the Node-side ZFA kernel. Arguments are structurally validated and interpolated:
a string always lands inside a rholang string literal (so it cannot escape its
position), an amount is always a BigInt of decimal digits (so the value approved
is the value signed).

Arguments are **not** content-policed, and the linter checks only that the
expansion is well-formed. There is no forbidden rholang — capability security
decides what a deploy can reach. Run `node rholang-macros.mjs --selftest` to
verify (26 cases).

Twenty macros, mirroring the `qucalc/examples/*.rho` in rchain-rust — see
[`RChain_Macros.md`](../../RChain_Macros.md) for the full library and for running
a local node.

`run-agents.sh` does not launch it: the browser expands locally, so the agent is
only worth a peer against the room-size ceiling above when you want the expansion
posted into chat for the room to read. Start it by hand if you do:
`node rholang-agent.mjs --room <cap> --name rholang`.

A room's **own** commands are a different library — `/macro define $name(…)`,
invoked `+name args`, expanded from
[`packages/browser/src/macro-lang.js`](../../packages/browser/src/macro-lang.js).
Both sigils expand in the same pass over a program, built-ins first. Nothing in
the agent uses the `$` half yet.

### Browser side (the zero-trust signing loop)

The agent only *expands*; the browser validates and signs. `packages/browser/src/rholang-pipeline.ts`
provides the client half of the pipeline:

- `lintRholang(source)` — runs the WASM linter (`crates/zfa-core/src/lint.rs`,
  exposed as `wasm_lint_ok` / `wasm_lint_errors`) on the expanded rholang.
- `generateKeyPair` / `storeKeyPair` / `loadKeyPair` — a passphrase-wrapped
  (PBKDF2 → AES-GCM) ECDSA keypair persisted in IndexedDB; the private key never
  leaves the browser.
- `signPayload` / `deployToNode` — sign and POST the deploy to the target node.
- `runDeployPipeline(source, { nodeUrl, passphrase })` — preview → lint → sign →
  deploy, returning a staged result the UI can display.

> Signing is ECDSA P-256 (Web Crypto has no secp256k1); swap `generateKeyPair` /
> `signPayload` for secp256k1 (`@noble/curves` or a WASM secp256k1) for real
> RChain deploys. The key-storage + lint + deploy flow is unchanged.

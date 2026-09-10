# Capability transport — shards connect securely in a room

Companion to [`Room_Bridges.md`](Room_Bridges.md) (information across rooms) and
[`Governance.md`](Governance.md) (a group as an identity). This document is about
moving **value and capabilities between shards** — RChain shards now, other
chains later — with a [quantum-os](README.md) room as the venue.

Status: **design + Phases 1–3 landed.** The shipped flow is deliberately
minimal: a **bridge is one account — this browser's `/rholang` key — with a
`captpEscrow` deployed on two rnodes**. `/captp new` registers the pair, `/captp setup`
deploys and cross-registers the two escrows, `/captp send` deploys the burn on one
node and the mint on the other (via
[`deployToNode`](packages/browser/src/rholang.ts), a per-node deploy) and
broadcasts the receipt to whatever room you are in. Verified end to end across
two real nodes with real funded deploys by
[`captp-e2e.mjs`](scripts/localnet/captp-e2e.mjs).

The rest of this document — a **derived coordination room**, group ownership,
multiple operators, non-key-holding users routed in through a helper — is the
**Phase 4** design. `deriveBridgeRoom` and the `captp-offer`/`captp-lock`/`captp-mint`
wire kinds are in the code, unused by the single-operator flow, waiting for it.
Tracked in [issue #173](https://github.com/rchain-community/quantum-os/issues/173).

---

## The idea

A capability system lets you *hand out* authority. What it has never let you do
in quantum-os is hand authority **across a trust boundary** — from one shard's
ledger to another's — without a custodian in the middle. That is the gap
[`bridge.mjs`](scripts/qos-cli/bridge.mjs) leaves open on purpose
([`Room_Bridges.md` "Honest scope"](Room_Bridges.md)): it relays lemmas and
governance verbatim, but **not** `/note` transfers, because relaying value across
rooms with no conservation check is a double-spend.

The reference for closing that gap is **Mark S. Miller's CapTP** (Capability
Transport Protocol; Agoric's `@endo/captp`, now standardized as
[OCapN](https://github.com/ocapn/ocapn)) and, as a value-transfer special case,
RChain's own cross-shard transfer design. Both share one move: **two parties who
do not share a ledger meet at a venue that stands in both, and the exchange
becomes an ordinary transaction there.** CapTP calls the venue a *netlayer
session*; RChain calls it the *nearest common ancestor shard*. quantum-os already
has the venue — a **room** — and already has the "stands in both" primitive — a
**bridge peer**, a member of two rooms whose simultaneous membership *is* the
shared closure between them (ER=EPR, [`Room_Bridges.md`](Room_Bridges.md)).

| CapTP / OCapN · RChain cross-shard | quantum-os |
|---|---|
| **Netlayer** — a transport-agnostic message channel | a **room** (WebRTC data channel, DTLS-encrypted end to end) |
| **Nearest common ancestor** — where a cross-shard exchange is a normal transaction | the **bridge room** — the interaction manifold |
| **Object reference / sturdyref** · a **purse** | a ZFA `cap:` token · a `/note` (split/merge preserve ZFA count-balance — "a purse sprouts from a purse") |
| **Vat** · a **shard** | a shard, reached over `/rholang`'s HTTP API, or via a helper daemon |
| **Mint / KonsensusProxy** — validator-gated burn-and-mint at the boundary | a rholang **`captpEscrow`** contract per shard, gated by the bridge account's `deployerId` |
| **Three-party handoff / "gifting"** — certificate-based introduction | group ownership of the bridge: a `/gov` decision is the certificate; `/gov censure` + treasury slash is the deterrent |
| **Distributed GC** | out of scope |

---

## A bridge is a dual-shard account

**A bridge is an identity that holds one account present on two or more shards.**

The account is one secp256k1 key. On RChain a `deployerId` — and the REV address
derived from it — is **shard-independent**: the same key is the same account on
every shard. So "the same account on two shards" is not an arrangement to
negotiate, it is one key used in two places. **Holding a funded, registered
account on both shard A and shard B _is_ the capability to bridge A and B** — no
counterparty, no permission. Anyone can stand up a bridge; many bridges between
the same pair coexist, and a user routes through whichever one they trust.

This is the same bearer-capability rule as everywhere else in quantum-os
(possessing the token is the authority), with one difference to state plainly:
a bridge account can be **shared**, and a shared key is **mutual unilateral
authority** — every holder can act alone on both shards. So a bridge is a
*cooperating* arrangement (one operator, or a trusting group), not a trustless
cross-organisation channel. The trust tiers below say what to do when that is
not enough.

### The owner is an identity — a person or a group

Unifying with [issue #103](https://github.com/rchain-community/quantum-os/issues/103)
("a group is an identity: the same capabilities as a person"):

- **a person** — a dyncap anchor; the account key lives in
  [`vault.ts`](packages/browser/src/vault.ts) (password-encrypted, the same
  store `/password` / `/login` use).
- **a group** — a group id (itself a `cap:` token); the account key lives in
  `Group.vaults`, replicated to members via the dyncap-signed `gov-vault`
  envelope on `sync-gov`, daemon-persisted. Rotate or remove access by ⅔, the
  quorum from [`Governance.md`](Governance.md).

Personal ownership is the degenerate case — a group of one — and takes the same
code path.

> **Phase 4, not the shipped flow.** Everything from here to the end of this
> section is the design for group-owned bridges and multi-operator coordination.
> The shipped single-operator flow needs none of it — a bridge is a stored
> `{shardA, shardB, idA, idB, escrowA, escrowB}` config, and `/captp send` runs
> two deploys from the one operator's key.

### The bridge room is derived, not minted

The room where a bridge operates is a **pure function of the owner id and the
(unordered) shard pair**:

```
roomCap = zfaRejectionSample( SHA256( "quantum-os/captp-room:v1"
                                      ‖ ownerId
                                      ‖ min(shardA, shardB)
                                      ‖ max(shardA, shardB) ) )
```

`deriveBridgeRoom` in [`captp.ts`](packages/browser/src/captp.ts). Every operator of
the account computes the same address; nothing is announced. The room is
**private because its address is only computable by the owner** — the same
predictable-derivation-from-a-key idiom the deploy-result registry slot already
uses (`registryUriOf`, [`rholang.ts`](packages/browser/src/rholang.ts)). The
derivation hashes to entropy, maps bytes to Hermitian-paired twists (so count
balance holds by construction), and rejection-samples on Pauli closure (~4
iterations) so the result is a first-class room id that passes
`validateCapability`.

A person's shard helpers and co-operators join this room **under their own
dyncap identities** — only the *deploy key* is shared, never a dyncap seed
(sharing a seed would read as a clone/fork, `SECURITY.md`).

### End users are not in the bridge room

Holding the bridge room's cap *is* bridge authority, so a user who merely wants
to move value across cannot be given it. Instead: the user stays in their own
room, and a **shard helper daemon** that is a member of both the user's room and
the bridge room carries the request in and the receipt back — verbatim,
signed-through, exactly as [`bridge.mjs`](scripts/qos-cli/bridge.mjs) relays
signed state today.

```
   user room  ──▶  (shard helper, in both rooms)  ──▶  bridge room  ──▶  (other helper)  ──▶  other user room
```

---

## The transfer — lock-and-mint

Value crossing from shard A to shard B. The escrow contract is
[`captp-escrow.js`](packages/browser/src/captp-escrow.js) (`CAPTP_ESCROW_RHO` +
`installProgram` / `lockProgram` / `mintProgram` / `refundProgram` /
`lockOfProgram` / `infoProgram`), one deployed per shard by the bridge account.

1. **Lock on A.** `captpEscrow.lock(amount, destAddrOnB, nonce)` on shard A. A
   reused `nonce` is refused; otherwise `amount` REV moves from the caller's
   vault to the bridge account's own address on shard A (`poolAddr`), a lock
   record `{subject, amount, destAddr, status:"locked"}` is stored under
   `nonce`, and the call returns the **burn receipt**
   `("captp-burn", shardA, subject, amount, nonce, destAddrOnB)`.
2. **Relay.** The burn receipt goes into the bridge room as a `captp-lock`
   envelope (dyncap-signed). A counterpart operator or an auditor can check it
   against shard A independently with `captpEscrow.lockOf(nonce)`.
3. **Mint on B.** `captpEscrow.mint(burnReceipt)` on shard B (owner only) checks
   the receipt shape, that `shardA` is a **registered counterpart**, and that
   `nonce` is unseen; then `amount` REV moves from the bridge account's address
   on shard B to `destAddrOnB`, and the mint receipt is stored under `nonce`.
   **Idempotent by nonce** — a replayed `captp-mint` returns the stored receipt
   and pays nothing.
4. **Receipt.** A permanent `captp-receipt` `(burnReceipt, mintReceipt, srcBlock,
   dstBlock)` is broadcast and stored (non-transferable, tombstone-aware, like
   `/note` receipts).

If the mint never happens, `captpEscrow.refund(nonce)` on shard A (owner only)
returns `amount` from `poolAddr` to the original subject and marks the lock
refunded. Atomicity is **best-effort, like `/rdv`** — safe under retry because
`mint` is nonce-idempotent and an un-minted `lock` is refundable by the same
nonce.

**On custody (Tier 1).** The shipped rnode's `revVault` binds a vault to a
deploy key (`findOrCreate` needs a `deployerId`), so the escrow contract cannot
hold REV in its own name — the in-transit amount sits in the bridge account's
`poolAddr` from the moment of `lock`, and `refund` is owner-gated. A Tier‑1
bridge operator is therefore trusted for good faith, with the deterrents being
social (`/gov censure`, the room's `captp-*` audit trail, `lockOf` verification)
rather than an on-chain guarantee. Tier 2 (below) is what removes that trust.
Bearer-`cap:` transport (a `proxyId` under `rho:qucalc:verify`, Phase 5) has no
custody question — nothing is escrowed, only forwarded and revocable.

### The rholang is the DNA, and rnode is untouched

`captpEscrow` is an ordinary rholang contract deployed **by the bridge account**
to each shard's registry through the existing `/rholang deploy` path
(secp256k1 over blake2b256 of the `DeployDataProto`). It is gated by
`deployerId` — the locker's "the id IS the authority" rule
([`locker.js`](packages/browser/src/locker.js)) — so only the bridge account
can `register` a counterpart or `refund`. A `$captp` macro family drives the
deploys ("the macro is the bridge",
[issue #138](https://github.com/rchain-community/quantum-os/issues/138)). It
uses only powerbox names that already ship (`rho:qucalc:verify`,
`rho:rchain:revVault`, `rho:registry:insertSigned`). **No new powerbox entry,
no rnode change** — the two small [rchain-rust#32](https://github.com/rchain-community/rchain-rust/issues/32)
asks (a non-empty `--shard-id` default, a build hash in `--version`) are
conveniences, not dependencies.

---

## Group ownership and policy

When a group owns the bridge, moving value is a governed act.

- **Custody** — the key is a `gov-vault` record under a `captp:<pair>` handle,
  replicated to members and daemon-persisted; ⅔ rotates it (and rotation
  matters after a member leaves — a departed member still saw past ciphertext,
  which is offline-crackable, `SECURITY.md`).
- **Policy** — `group-meta` records the bridge's `{ pair, escrowUris,
  autoThreshold }`. A transfer at or below `autoThreshold` executes
  immediately (any vault-holding member). Above it, `/captp send` opens a `/gov`
  issue and a bound `/poll`, and the **mint leg waits for a weighted ⅔**
  (`resolveWeights` + `trustWeightsFor` — delegation- and trust-weighted, per
  [`Governance.md`](Governance.md)).
- **Liquidity** — the timing gap (locked on A, not yet minted on B) is covered
  by the group's `/gov treasury` currency; bridge fees accrue there.
- **Accountability** — a member who authorised a bad transfer is `/gov censure`d
  → discredited, their vouchers slashed. This is the deterrent that makes
  social enforcement real rather than nominal.

---

## Trust tiers — one consistent pattern

quantum-os's answer to "is bearer + social accountability enough?" is always the
same shape: **yes by default, with a cryptographic hardening tier when the value
justifies its cost.**

### Tier 1 — base (the default)

One account key. Authenticity and continuity in the room come from **dyncap**
chains; misbehaviour is caught by **`/gov censure` + treasury slash** and by
**dyncap fork detection** (an equivocating helper). Atomicity is best-effort
plus on-chain nonce idempotency. A group vote over a transfer is advisory and
audited — every vault-holding member can still wield the key on-chain.

### Tier 2 — hardening (built when a bridge needs it)

For adversarial or high-value bridges, escalated to by a group-set threshold:

- **Distinct per-shard keys + attestation quorum.** Each shard's helper keeps
  its own key and broadcasts a **secp256k1-signed** attestation
  `{ program, preStateHash, postStateHash, result, blockHash }`; the room
  confirms a leg only when attestations reach a `/probe`-style supermajority,
  `/gov`-trust-weighted (`captp-quorum.ts`, mirroring
  [`probe.ts`](packages/browser/src/probe.ts)).
- **On-chain multisig escrow.** `captpEscrow` gated by an M-of-N threshold over
  members' individual keys (`$multisig` territory) instead of the one shared
  key — real enforcement, at the cost of every member being funded on both
  shards and every transfer collecting signatures.

---

## The double-spend nullifier

[`SECURITY.md`](SECURITY.md) records that a holder copying a note's bytes and
spending them in a different room is **undetectable** — "closing it would
require a shared nullifier set, which means consensus — out of scope."

**That limitation is resolved for `/captp` transfers.** `captpEscrow`'s
consumed-nonce set lives on a deterministic, replicated rnode — it *is* the
shared nullifier set, and a shard *is* the consensus the earlier note said would
be needed. A `lock` whose nonce is already spent is rejected; a `mint` whose
nonce is already seen returns the prior result. Plain `/note pass` across rooms
stays undetectable; a transfer that goes through a shard does not.

---

## Honest scope

- **Best-effort atomicity.** Like `/rdv`. If a helper vanishes between `lock`
  and `mint`, the transfer stalls until refunded — value is never lost, but a
  crossing is not instantaneous or guaranteed to complete without a refund.
- **The nullifier holds only while a shard is in the loop.** The guarantee is a
  property of the escrow contract on a live rnode, not of the room.
- **A shared bridge key is mutual unilateral authority.** Tier 1 is for
  cooperating operators. Tier 2 exists precisely for when they are not.
- **Tier 1 has a custody window.** Locked value sits in the bridge account's
  address between `lock` and `refund`/`mint`, and `refund` is owner-gated —
  see "On custody" above. A self-service timeout refund needs block height in
  the contract and is deferred; Tier 2 removes the trust rather than softening
  it.
- **The escrow rholang is verified end to end.**
  `scripts/localnet/captp-escrow-check.mjs` drives every verb on a live rnode
  (`revVault` stubbed); `scripts/localnet/captp-e2e.mjs` does the whole flow with
  **real signed, genesis-funded deploys** — install both escrows, register,
  a funded `lock` and `mint` — and asserts the recipient's REV balance moved by
  the transfer amount. Both pass on bin/rnode 0.1.0. What is *not* yet covered:
  a failed `revVault` transfer's reply shape (the shipped build may not reply at
  all — CLAUDE.md), and a self-service timeout refund (needs block height in the
  contract).
- **Revocation binds only those who check** ([issue #107](https://github.com/rchain-community/quantum-os/issues/107)).
  A capability transported as a proxy can be switched off by its owner
  (a dyncap anchor, or a ⅔ group) via a `proxy-set` envelope and a `revoke`
  deploy to the source escrow; a peer that was offline for the revocation keeps
  its stale view until it re-syncs. "Revoked" and "gone" are shown as the
  different facts they are.

---

## Future — interface to Agoric

The wire vocabulary (`captp-offer` / `captp-lock` / `captp-mint` / `captp-receipt`) and
the receipt shape are chosen to line up with **OCapN**'s `op:deliver` /
`op:deliver-only` and its handoff-certificate model, so a future
`scripts/qos-cli/ocapn-netlayer.mjs` adapter can present a quantum-os room as an
OCapN session and bridge it to an **Agoric** (or Spritely Goblins) endpoint —
a room becomes a session, a `cap:` token maps to a sturdyref, and the room's
witness set (or a group decision) is the handoff certificate. This is an
aspiration, not a commitment to track the draft spec; the base design does not
depend on it.

---

## Related

- [`Room_Bridges.md`](Room_Bridges.md) — information across rooms; the bridge-peer / ER=EPR model this builds on.
- [`Governance.md`](Governance.md) — a group as an identity; delegation- and trust-weighted tally; treasury; censure.
- [`SECURITY.md`](SECURITY.md) — the threat model, including the double-spend limitation this closes for `/captp`.
- [issue #173](https://github.com/rchain-community/quantum-os/issues/173) — the tracking issue for this work.
- [issue #138](https://github.com/rchain-community/quantum-os/issues/138) — rnodes as room members, multi-chain, "the macro is the bridge".
- [issue #107](https://github.com/rchain-community/quantum-os/issues/107) — revocable proxy capabilities.
- [issue #103](https://github.com/rchain-community/quantum-os/issues/103) — a group is an identity.
- [OCapN](https://github.com/ocapn/ocapn) · Agoric [`@endo/captp`](https://www.npmjs.com/package/@endo/captp) — the reference protocol.

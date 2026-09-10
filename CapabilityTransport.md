# Cross-shard — the linked invoke, and CapTP on top

Companion to [`Room_Bridges.md`](Room_Bridges.md) (information across rooms) and
[`Governance.md`](Governance.md) (a group as an identity). This is about
**coordination between shards** — RChain shards, and other chains later.

Two layers, and most uses only need the first:

| layer | what | where |
|---|---|---|
| **1 — linked invoke** | your *own* account, signed — a remote deploy to another shard to invoke a capability there | [rchain-rust#33](https://github.com/rchain-community/rchain-rust/issues/33) / [#34](https://github.com/rchain-community/rchain-rust/pull/34) |
| **2 — CapTP** | handing someone a *revocable, attenuated* proxy that acts on your behalf; promise pipelining; routing to non-linked shards and other chains | [quantum-os#173](https://github.com/rchain-community/quantum-os/issues/173) |

Status: **Layer 1 in draft** ([rchain-rust#34](https://github.com/rchain-community/rchain-rust/pull/34):
`casper::shard_invoke`, the decision record, the exchange contract — CI green,
and the branch build verified against the local chain). Layer 2 is design.
An earlier quantum-os cut (a burn/mint value-transfer escrow, `/captp` command)
was built and removed — it moved the platform token and assumed equal value,
both ruled out. What is kept client-side:
[`deployToNode`](packages/browser/src/rholang.ts) (deploy to a specific node,
per-node result-slot nonce) and this document.

---

## Not, at either layer

- **No burn or mint of the platform token (REV). Ever.** Nothing here touches
  `rho:rchain:revVault`. A token that wants cross-shard movement exposes a
  `transfer` method on its own contract; a caller invokes *that*.
- **No assumption that tokens are REV, fungible, or of equal value.**
- **No value teleportation.** A capability stays on its home shard.

---

## Layer 1 — the linked invoke (the primitive)

Identity is **not bridged — it is already the same.** A `deployerId` (and the
REV address derived from it) is shard-independent: your secp256k1 key *is* the
same account on every shard. So invoking a capability on another shard is not
a transport problem — it is signed message-passing where the far shard binds
*your own* `deployerId`.

**It is an ordinary, caller-signed deploy submitted to the target shard —
no relay, no link table, no new consensus** (resolved in
[rchain-rust#33](https://github.com/rchain-community/rchain-rust/issues/33),
draft PR rchain-rust#34). A deploy already *is* the signed message that carries
the identity; a home-shard relay would have to re-sign a different payload as
the caller, which the home node cannot do (it holds only the public key).

- **`$at(shard, `rho:id:x`)!(method, args…)`** expands, at the client, to a
  normal deploy signed with the caller's key, whose term runs on the target
  shard:
  ```rholang
  new lookup(`rho:registry:lookup`), cap in {
    lookup!(`rho:id:x`, *cap) |
    for (@(_, target) <- cap) { @target!(method, args…, `rho:rchain:deployId`) }
  }
  ```
- **Identity:** the far node binds `rho:rchain:deployerId` from the signature —
  the caller's own key — so a `deployerId`-gated capability there (the locker,
  an escrow facet) sees exactly the caller it would locally. Nothing is
  delegated or wrapped.
- **Reply:** written to `` `rho:rchain:deployId` `` (the deploy's own id). The
  client **listens on that channel** (`listenForDataAtName`) and resolves on
  the value — no `deployStatus` polling; a caller-local `*ret` cannot cross
  shards, so a channel listen is the equivalent of a local `for`.
- **Failure is a value:** a missed lookup, a rejected deploy, or a listen that
  times out yields `("shard-error", reason)` — never a hang.
- **Phlo** is charged to the caller's account on the far shard — the same
  account, same key, same REV vault.
- **The "link table" collapses** to an endpoint (the target's deploy service)
  plus the registry URI (the capability handle you were handed). Reachability,
  not authority; no replicated link state, so no new consensus. Revocation is
  the far contract's own authorization, or not handing out the URI.
- **The security is capability security, which is proven:** you can only invoke
  a URI you were handed; the far contract enforces whatever it enforces against
  your real identity.

**Honest consequence.** A remote deploy is a *separate transaction* on the far
shard, so it cannot compose into one home-shard closure. A bilateral exchange
is therefore **client-orchestrated and non-atomic across shards**: each escrow
is individually conserved, and the joint ZFA closure is a `rho:qucalc:verify`
*monitor* over committed facts, not a transport guarantee. Atomic
single-closure composition would be Layer 2, and is deliberately out of rnode.

### Exchange support — a contract on Layer 1

Two shapes, both built:

- **Bilateral escrow** (`qucalc/examples/shard_exchange.rho`, rchain-rust#34):
  an escrow on each shard, pre-funded, fixed rate; a send `deposit`s locally and
  `consume`s the remote one through a remote invoke.
- **Pooled exchange** (`packages/browser/src/rholang-exchange.js`, quantum-os;
  `$xopen` / `$xprovide` / `$xdeposit` / `$xquote` / `$xswap` / `$xwithdraw`):
  a pool trades one token pair at an owner-set rate; `$xlink` / `$xroute`
  federate it — `route` swaps locally, then returns a
  `("$at", shard, uri, "swap", …)` descriptor the client runs as a cross-shard
  remote deploy. Verified end to end against localnet. A quantum-os `/note`
  currency reaches a pool as its token contract's URI.

Both: conservation held per pool/escrow, and the transport is a remote deploy —
so a multi-shard route is **not atomic**.

**Capability security is the proof.** The escrow contract exposes no method that
pays the operator, holds no capability that drains it outside the rate, and
fixes or governs the rate at deploy. There is nothing to corrupt because there
is no ambient authority. The joint-ZFA-closure reading — one closure spanning
both escrows (`crates/zfa-core/src/coupling.rs` `coupled`) — is a *check* the
contract runs with `rho:qucalc:verify`, which rnode already exposes, not a
prerequisite. Because the two legs are separate deploys, the joint check is a
**monitor** over committed facts, not a precondition of one atomic move.
rchain-rust already carries the QLF primitives, so the escrow lives there.

---

## Layer 2 — CapTP (the delegation layer)

CapTP ([Mark S. Miller](https://github.com/ocapn/ocapn); Agoric `@endo/captp`,
standardized as OCapN) earns its complexity only when the authority **is not
your own account**:

- **Revocable, attenuated proxies.** You export a capability as a *proxy* —
  someone else holds it, invokes it *on your behalf*, cannot escalate it to
  your full identity, and you can switch it off (#107). `$proxy(uri, methods)`
  → a `cap:` token the holder invokes; the on-shard forwarder checks it against
  your grant, not their identity.
- **Promise pipelining.** Send a message to the *result* of a cross-shard call
  before it resolves. A promise-proxy is returned immediately; further
  invocations queue against it.
- **Three-party handoff.** Introduce a party who has no pre-existing link, with
  a certificate the room's witnesses or a `/gov` decision issue.
- **Gateway routing.** A quantum-os peer that is a member of a coordination room
  and can deploy to a shard's rnode, for shard pairs with no link — and, via an
  oracle contract the agent carries, to non-RChain chains. The gateway signs
  the deploy, so `*deployerId` there is the *gateway*: the gateway path suits
  public / stateless capabilities and ones written to take an explicit,
  contract-verified caller.

Embedded in a deploy, the result comes back on a channel — **rholang's `for` is
the promise:**

```rholang
new price in {
  $at("shard-b", `rho:id:theOracle`)!("getPrice", "ETH", *price) |
  for (@p <- price) { … }
}
```

`$at(shard, uri)` expands, at the client, to a **remote signed deploy** whose
reply lands on `` `rho:rchain:deployId` `` (Layer 1 — the client listens on that
channel), or to **gateway-routing glue** (Layer 2 — a promise-proxy the client
machinery resolves). Same call site either way; the `for` above is the local
idiom the client presents over the channel listen.

Revocation binds only those who check: a peer offline for a `proxy-revoke` keeps
its stale view until it re-syncs; *revoked* is shown as distinct from *gone*.

---

## Phases

1. **Layer 1** — the client-side `$at` → remote signed deploy + reply-channel
   listen (rchain-rust#33 / #34: `casper::shard_invoke`).
2. Exchange support — the bilateral escrow contract
   (`qucalc/examples/shard_exchange.rho`, rchain-rust#34).
3. **Layer 2** — `$proxy` + the gateway peer + `captp-export` / `captp-invoke`
   / `captp-result` / `captp-revoke`; synchronous invocation.
4. Promise pipelining.
5. Three-party handoff + revocation (#107).
6. OCapN wire conformance — interop with Agoric / Spritely endpoints.

---

## Related

- [`ExchangeDemo.md`](ExchangeDemo.md) — end-user walkthrough of the pooled token exchange and its `link`/`route` cross-shard federation over Layer 1.
- [`Room_Bridges.md`](Room_Bridges.md) — a peer in two rooms is the shared closure (the gateway is that, between a room and a shard).
- [`Governance.md`](Governance.md) — group ownership of a gateway; delegation- and trust-weighted decisions; censure.
- [quantum-os#173](https://github.com/rchain-community/quantum-os/issues/173) (Layer 2) · [rchain-rust#33](https://github.com/rchain-community/rchain-rust/issues/33) (Layer 1) · [#138](https://github.com/rchain-community/quantum-os/issues/138) · [#107](https://github.com/rchain-community/quantum-os/issues/107).
- [OCapN](https://github.com/ocapn/ocapn) · Agoric [`@endo/captp`](https://www.npmjs.com/package/@endo/captp).

# Cross-shard — the linked invoke, and CapTP on top

Companion to [`Room_Bridges.md`](Room_Bridges.md) (information across rooms) and
[`Governance.md`](Governance.md) (a group as an identity). This is about
**coordination between shards** — RChain shards, and other chains later.

Two layers, and most uses only need the first:

| layer | what | where |
|---|---|---|
| **1 — linked invoke** | your *own* account, signed, reaching across a link to invoke a capability on another shard | [rchain-community/rchain-rust#33](https://github.com/rchain-community/rchain-rust/issues/33) |
| **2 — CapTP** | handing someone a *revocable, attenuated* proxy that acts on your behalf; promise pipelining; routing to non-linked shards and other chains | [quantum-os#173](https://github.com/rchain-community/quantum-os/issues/173) |

Status: **design.** A first cut (a burn/mint value-transfer escrow, `/captp`
command) was built and removed — it moved the platform token and assumed equal
value, both ruled out. What is kept:
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

- **A link** between two rnodes: a mutual registration holding each rnode's
  endpoint and the set of registry URIs that shard exposes to the link. **No
  identity key on the link** — reachability, not authority. A link cannot reach
  a URI it was not granted.
- **`rho:shard:invoke(linkId, targetUri, method, args, *ret)`** — runs inside
  *your* deploy on the home shard, so rnode has your real `deployerId`. It
  relays `{caller: deployerId, sig, targetUri, method, args}` over the link;
  the far rnode **verifies `sig` against `deployerId`, binds it**, and runs
  `lookup(targetUri) → target!(method, …args, *r)` as that identity. A
  `deployerId`-gated capability there (the locker, an escrow facet) sees exactly
  the identity it would if you had deployed locally. Phlo is charged to your
  account on the far shard. Failure is a value — `("shard-error", reason)` —
  not a hang.
- **Trust model:** your own key + the registry uri + the link grant. No
  intermediary. This is why Layer 1 needs no CapTP.
- **The security is capability security, which is proven:** you can only invoke
  a uri you were handed and the link was granted; the far contract enforces
  whatever it enforces against your real identity.
- **Composability:** the invoke happens inside the home shard's reduction, so it
  composes with local operations into one closure — which is what makes a
  joint-ZFA-closure conservation check meaningful (see *Exchange support*).

Keep rnode minimal: **one powerbox process + a link table.** No new consensus —
message passing, not shared state. Discovery, governance, the client-side
promise machinery, non-RChain chains, and everything in Layer 2 stay out of
rnode.

### Exchange support — a contract on Layer 1

A bilateral exchange-rate escrow for fungible *non-REV* tokens: an escrow on
each side, pre-funded, with an exchange rate. A send adds to the local escrow
and consumes from the remote one through `rho:shard:invoke`, conservation held
per escrow.

**Capability security is the proof.** The escrow contract exposes no method that
pays the operator, holds no capability that drains it outside the rate, and
fixes or governs the rate at deploy. There is nothing to corrupt because there
is no ambient authority. The joint-ZFA-closure reading — one closure spanning
both escrows (`crates/zfa-core/src/coupling.rs` `coupled`) — is a *check* the
contract runs with `rho:qucalc:verify`, which rnode already exposes, not a
prerequisite. rchain-rust already carries the QLF primitives, so the escrow
lives there.

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

`$at(shardOrLink, uri)` expands to a `rho:shard:invoke` (Layer 1, a link) or to
the gateway-routing glue (Layer 2, no link) — the same call site either way.

Revocation binds only those who check: a peer offline for a `proxy-revoke` keeps
its stale view until it re-syncs; *revoked* is shown as distinct from *gone*.

---

## Phases

1. **Layer 1** — `rho:shard:invoke` + the link table (rchain-rust#33); `$at`
   resolving to a link.
2. Exchange support — the bilateral escrow contract (rchain-rust#33).
3. **Layer 2** — `$proxy` + the gateway peer + `captp-export` / `captp-invoke`
   / `captp-result` / `captp-revoke`; synchronous invocation.
4. Promise pipelining.
5. Three-party handoff + revocation (#107).
6. OCapN wire conformance — interop with Agoric / Spritely endpoints.

---

## Related

- [`Room_Bridges.md`](Room_Bridges.md) — a peer in two rooms is the shared closure (the gateway is that, between a room and a shard).
- [`Governance.md`](Governance.md) — group ownership of a gateway; delegation- and trust-weighted decisions; censure.
- [quantum-os#173](https://github.com/rchain-community/quantum-os/issues/173) (Layer 2) · [rchain-rust#33](https://github.com/rchain-community/rchain-rust/issues/33) (Layer 1) · [#138](https://github.com/rchain-community/quantum-os/issues/138) · [#107](https://github.com/rchain-community/quantum-os/issues/107).
- [OCapN](https://github.com/ocapn/ocapn) · Agoric [`@endo/captp`](https://www.npmjs.com/package/@endo/captp).

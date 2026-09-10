# Capability transport — sharding with CapTP, quantum-os as the linking layer

Companion to [`Room_Bridges.md`](Room_Bridges.md) (information across rooms) and
[`Governance.md`](Governance.md) (a group as an identity). This is about
**coordination between shards** — RChain shards, and other chains later — using
[Mark S. Miller's **CapTP**](https://github.com/ocapn/ocapn) (Capability
Transport Protocol; Agoric's `@endo/captp`, standardized as OCapN) as the model,
with a [quantum-os](README.md) peer as the transport.

Status: **design.** A first cut (a burn/mint value-transfer escrow, `/captp`
command) was built and then removed — it moved the platform token and assumed
equal value, both of which this design rules out. What is kept:
[`deployToNode`](packages/browser/src/rholang.ts) (deploy to a specific node,
per-node result-slot nonce) and this document. Tracked in
[quantum-os#173](https://github.com/rchain-community/quantum-os/issues/173)
(client side) and
[rchain-rust#33](https://github.com/rchain-community/rchain-rust/issues/33)
(remote name proxies + exchange support + the `rho:shard:invoke` node
extension).

---

## What this is not

- **No burn or mint of the platform token (REV). Ever.** The transport never
  touches `rho:rchain:revVault`. If a token wants cross-shard movement, its
  *own* contract implements a `transfer` (or burn/mint) method and exposes it
  as a capability; a caller invokes *that*. REV's vault exposes no such method
  to the transport.
- **No assumption that tokens are REV, fungible, or of equal value.** A
  capability is a capability — a purse, a mint, a contract facet, an oracle, a
  data name. The transport moves *messages to it*, not the thing.
- **No value teleportation.** A capability stays on its home shard. Other
  parties hold a **proxy** — a reference that routes invocations home.

---

## The model

### Remote capabilities, embedded in a deploy

You reference a remote capability inside a rholang program you sign and deploy.
The result comes back on a channel — **rholang's `for` is the promise**.

```rholang
new price in {
  $at("shard-b", `rho:id:theOracle`)!("getPrice", "ETH", *price) |
  for (@p <- price) { … }        // pipeline: send more before p resolves
}
```

`$at(shardOrLink, uri)` — a macro (the `$` sigil is lexically illegal in
rholang, so a missed expansion fails loud at rnode) — expands to the glue that
routes the message. Two routes:

- **quantum-os gateway** (general): a peer that is a member of a coordination
  room and can deploy to the home shard's rnode. It receives a `captp-invoke`
  envelope, deploys `target!(method, …args, *ret)` on the home shard, and
  relays `captp-result`. Works for any rnode pair, and — via an oracle contract
  the agent carries — to non-RChain chains.
- **linked shards** (direct): where two rnodes are formally *linked*, a
  rchain-rust extension (`rho:shard:invoke(linkId, targetUri, method, args,
  *ret)` + a link table) sends the invocation node-to-node with no peer
  relaying it. Charged to the link's account; no new consensus — message
  passing, not shared state; the security is the link registration (which caps
  each shard exposes to which link). [rchain-community/rchain-rust#33](https://github.com/rchain-community/rchain-rust/issues/33).

### Full CapTP promise semantics

- An invocation returns a **promise-proxy** immediately. Further invocations on
  it queue and **pipeline** — sent before the first resolves.
- **Three-party handoff:** a proxy can be passed to a third party, who can then
  invoke it directly (through their own gateway link), with a certificate the
  room's witnesses (or a `/gov` decision) issue.
- **Revocation** ([#107](https://github.com/rchain-community/quantum-os/issues/107)):
  the exporter (a dyncap anchor, or a ⅔ group) tells the gateway to stop
  routing for a proxyId. The on-shard capability is untouched; the proxy holder
  sees *revoked*, distinct from *gone*.

### The gateway's trust

The gateway signs every deploy it routes, so it can invoke things you did not
ask for. Tier 1 is social accountability (`/gov censure`, the room's `captp-*`
audit trail). Tier 2 is a co-signed invocation, or an on-shard contract that
checks the original caller's identity (carried in the envelope).

---

## Exchange support — bilateral exchange-rate escrow

For fungible *non-REV* tokens: an escrow on each side, pre-funded, with an
exchange rate. A send **adds to the local escrow and consumes from the remote
escrow** (through a linked-shard `rho:shard:invoke`), conservation held per
escrow.

This is **not an open research problem** — capability security is the proof.
The escrow contract exposes no method that pays the operator, holds no
capability that drains it outside the rate, and fixes (or governs) the rate at
deploy. There is nothing to corrupt because there is no ambient authority to
corrupt with. The joint-ZFA-closure reading (one closure spanning both escrows,
`crates/zfa-core/src/coupling.rs` `coupled`) is a *check* the contract can run
with `rho:qucalc:verify` — which rnode already exposes — not a prerequisite.

**This belongs in rchain-rust** ([rchain-rust#33](https://github.com/rchain-community/rchain-rust/issues/33)),
alongside the remote-name-proxy support and the QLF primitives it already
carries. quantum-os is the client: the `$at` macro, the gateway peer, the
coordination room, revocation, governance.

---

## Phases

1. `$at` macro + the quantum-os gateway peer + `captp-export` / `captp-invoke`
   / `captp-result` / `captp-revoke` — synchronous invocation first.
2. Full promise pipelining.
3. Three-party handoff + revocation (#107).
4. OCapN wire conformance — interop with Agoric / Spritely endpoints.
5. Linked shards — the rchain-rust `rho:shard:invoke` extension ([rchain-rust#33](https://github.com/rchain-community/rchain-rust/issues/33)).
6. Exchange support — the bilateral exchange-rate escrow (rchain-rust#33).

---

## Related

- [`Room_Bridges.md`](Room_Bridges.md) — a peer in two rooms is the shared closure (the gateway is that, between a room and a shard).
- [`Governance.md`](Governance.md) — group ownership of a gateway; delegation- and trust-weighted decisions; censure.
- [`SECURITY.md`](SECURITY.md) — the cross-room double-spend limitation this does *not* claim to close for value.
- [issue #173](https://github.com/rchain-community/quantum-os/issues/173) · [#138](https://github.com/rchain-community/quantum-os/issues/138) (rnodes as room members) · [#107](https://github.com/rchain-community/quantum-os/issues/107) (revocable proxy).
- [OCapN](https://github.com/ocapn/ocapn) · Agoric [`@endo/captp`](https://www.npmjs.com/package/@endo/captp) — the reference protocol.

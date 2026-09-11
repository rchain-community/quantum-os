# A Token Exchange in Rholang

A walkthrough of the pooled token exchange in [quantum-os](README.md): create
your own currency and persist it on-chain, deploy a pool, seed it, trade
against it, and **federate** two exchanges across shards so a trade can hop
between them — atomically. Actors: **Alice** and **Bob** each mint a personal
currency and trade them, Alice runs the exchange on shard A, and a **Paris**
exchange runs on shard B.

Everything below is one line each, typed into a [quantum-os](README.md) room
after `/rholang key generate` (or an existing funded key) — `$xinstall()`
deploys a fresh exchange, and the rest are ordinary `$name(…)` macro calls,
no `/` command of their own. (For the curious: the contract itself is
[`rholang-exchange.js`](https://github.com/rchain-community/quantum-os/blob/main/packages/browser/src/rholang-exchange.js),
the macros are registered in
[`rholang-macros.js`](https://github.com/rchain-community/quantum-os/blob/main/packages/browser/src/rholang-macros.js) —
neither needs reading to follow this walkthrough.) Native platform tokens
(REV, or any chain's own) trade too — **wrapped**, never directly; see §6.

---

## 1. Create and persist a personal currency

A `/note` currency is a bearer label that lives only in the room — gone if
nobody carries it forward. To trade one, it needs to exist **on-chain**, as
its own token contract. That's one macro:

```
Alice ▸ $winstall(aliceAddr, "AliceCoin")
        ✓ Success!  → rho:id:coin4a…      (AliceCoin's URI; Alice is the issuer)
```

`aliceAddr` is Alice's own REV address — recorded as the contract's
`backingAddr`, informational for a currency like this one, backed by nothing
but Alice's word (exactly like a `/note` currency, just now **persisted**:
reachable by anyone holding the URI, independent of the room or Alice's
browser staying open). She mints some to herself, and — since `mint` can
credit *any* address — some straight to Bob, so he has something to trade
with her later:

```
Alice ▸ $mint(rho:id:coin4a…, 1000, aliceAddr)
        ✓ → ("minted", 1000, "aliceAddr…", 1000)
Alice ▸ $mint(rho:id:coin4a…, 100, bobAddr)
        ✓ → ("minted", 100, "bobAddr…", 1100)
```

Bob does the same for his own currency, minting some to Alice:

```
Bob ▸ $winstall(bobAddr, "BobBucks")
      ✓ Success!  → rho:id:bux9k7…      (BobBucks' URI; Bob is the issuer)
Bob ▸ $mint(rho:id:bux9k7…, 1000, bobAddr)
      ✓ → ("minted", 1000, "bobAddr…", 1000)
Bob ▸ $mint(rho:id:bux9k7…, 500, aliceAddr)
      ✓ → ("minted", 500, "aliceAddr…", 1500)
```

Two personal currencies, each backed by nothing but their issuer's own word
— the same trust model as a `/note` currency — now existing on-chain where
an exchange can reach them. (`mint` is issuer-gated on-chain, so this is
safe to run as-is; there is no general holder-to-holder transfer yet, only
an issuer minting to whoever they choose, or a holder burning their own
balance via `$unwrap` §6 — a plain P2P transfer is a natural follow-up,
[open an issue](#found-a-gap-or-want-a-new-capability) if you want it.)

---

## The model

A **pool** trades one ordered token pair `(A, B)` at an **owner-set fixed
rate**. The rate is fixed-point: `rate` units of B per `1e6` units of A. So
`rate = 500000` means 0.5 B per A.

```
pool "ALICE-BOB"
  ├─ owner      *deployerId of whoever ran "open"
  ├─ tokenA     rho:id:coin4a…   (AliceCoin's own contract)
  ├─ tokenB     rho:id:bux9k7…   (BobBucks' own contract)
  ├─ rate       500000           (0.5 BobBucks per AliceCoin, ×1e6)
  ├─ reserveA   0   ─┐  the pool's liquidity, seeded by the owner with
  ├─ reserveB   0   ─┘  "provide" (the tokens were moved in out of band)
  └─ links      {}                peer exchanges on other shards
```

Each trader has an **in-pool balance** per pool — `{a, b}` keyed by their
`*deployerId`. You `deposit` a token you moved to the exchange, `swap` moves
between your `a` and `b` at the rate (adjusting the reserves oppositely), and
`withdraw` debits your balance so you can move the token back out.

`swap` **refuses to overdraw** either your balance or the pool reserve — so
each pool is individually conserved, and that is the whole proof: no verb pays
the operator, the pool holds no ambient authority, the rate is fixed at deploy
(changed only by the owner, via `setRate`).

### The verbs

| verb | who | what |
|---|---|---|
| `open(poolId, tokenA, tokenB, rate)` | anyone (becomes owner) | create a pool; returns its cap URI |
| `provide(side, amount)` | owner | add to `reserveA` / `reserveB` |
| `deposit(side, amount)` | anyone | credit your in-pool balance |
| `quote(fromSide, amount)` | anyone (read) | what you'd get at the current rate |
| `swap(fromSide, amount)` | anyone | trade from your balance, against the reserve |
| `withdraw(side, amount)` | anyone | debit your balance |
| `setRate(rate)` | owner | change the rate |
| `inspect()` | anyone (read) | rate, reserves, links |
| `link(name, exchangeUri, shard)` | owner | record a peer exchange on another shard |
| `prepare(txId, fromSide, amount, expiryBlock)` | anyone | **local leg** of a cross-shard trade: swap now, hold a reversible tx record |
| `prepareReceive(txId, side, amount, expiryBlock, link)` | anyone | **remote leg**: credit `amount` as if deposited, swap it, hold a reversible record — gated to a registered `link` |
| `commit(txId)` | the tx's own holder | finalize a prepared tx (idempotent) |
| `abort(txId)` | the tx's own holder | reverse a prepared tx exactly (idempotent; self-only — see §7) |
| `stateOf(txId)` | anyone (read) | a tx's status — the recovery primitive |

Thirteen of these fourteen have a `$x*` macro (`$xopen` `$xprovide`
`$xdeposit` `$xquote` `$xswap` `$xwithdraw` `$xlink` `$xinspect` `$xprepare`
`$xreceive` `$xcommit` `$xabort` `$xstateof`), plus `$xinstall()` to deploy
the exchange itself in the first place; `setRate` is called through the raw
`setRateProgram` builder or a hand-written `/rholang deploy`.

---

## 2. Alice deploys an exchange

One macro installs the contract; its answer is the exchange URI every later
call resolves through.

```
Alice ▸ $xinstall()
        ✓ Success!  → rho:id:9xm7c…iwwjuio
```

She records `rho:id:9xm7c…` — the **exchange URI**. Anyone she gives it to can
open pools and trade; only the pool's own `open`er can `provide` / `setRate` /
`link` it.

---

## 3. Open the AliceCoin–BobBucks pool

```
Alice ▸ $xopen(rho:id:9xm7c…, "ALICE-BOB", rho:id:coin4a…, rho:id:bux9k7…, 500000)
        ✓ → rho:id:4z9p3…            (the pool's cap — a receipt of ownership)
```

`rho:id:coin4a…` and `rho:id:bux9k7…` are the two currencies' own contracts
from §1. The rate `500000` is 0.5 BobBucks per AliceCoin.

---

## 4. Alice seeds liquidity

Alice moves the 500 BobBucks Bob minted her into the exchange, and records it
as pool reserve:

```
Alice ▸ $xprovide(rho:id:9xm7c…, "ALICE-BOB", B, 500)
        ✓ → 500                    (reserveB)
```

Now the pool can pay out up to 500 BobBucks of swaps.

---

## 5. Bob trades AliceCoin → BobBucks

Bob has the 100 AliceCoin Alice minted him. He moves it into the exchange and
records it:

```
Bob ▸ $xdeposit(rho:id:9xm7c…, "ALICE-BOB", A, 100)
      ✓ → 100                       (Bob's in-pool balance: {a: 100, b: 0})
```

He checks the price, then swaps:

```
Bob ▸ $xquote(rho:id:9xm7c…, "ALICE-BOB", A, 100)      (a read — no phlo, no block)
      → {"toSide": "B", "out": 50}

Bob ▸ $xswap(rho:id:9xm7c…, "ALICE-BOB", A, 100)
      ✓ → {"gave": 100, "got": 50, "toSide": "B"}
```

Bob's balance is now `{a: 0, b: 50}`; the pool's reserves moved to
`reserveA: 100, reserveB: 450` — conserved. Bob withdraws his BobBucks:

```
Bob ▸ $xwithdraw(rho:id:9xm7c…, "ALICE-BOB", B, 50)
      ✓ → {"withdraw": 50, "side": "B", "left": 0}
```

The exchange is an accountant, not a custodian of last resort: it records
who is owed what, and the token contracts do the actual moving. **Verified
end to end against localnet** — both currencies created and minted live,
the pool opened, seeded, deposited into, quoted, swapped, and withdrawn,
exactly as shown.

---

## 6. Wrapped native tokens — trading REV itself

The exchange never touches `revVault` — so REV (or any chain's own token)
participates only as a **wrapped** token, the same `$winstall` from §1 with
one extra macro. Alice issues one:

```
Alice ▸ $winstall(myRevAddr, "REV")
        ✓ Success!  → rho:id:wrap7…      (the wrapper URI; Alice is the issuer)
```

**`$wrap` — the one macro in this whole design that touches `revVault`,**
because it's Alice's own sanctioned deploy: a real REV transfer to the
wrapper's backing address, then mint — chained in one program, so there is
no window where REV moved but nothing was minted (or vice versa). This is
the difference from §1's `$mint`: a personal currency is minted on your word
alone; a wrapped native token is minted only against a real transfer that
just happened:

```
Alice ▸ $wrap(rho:id:wrap7…, myRevAddr, 10, myRevAddr)
        ✓ → ("minted", 10, "myRevAddr…", 10)
```

Now `rho:id:wrap7…` is a token like any other — `$xopen` a `wREV-wFOO` pool
with it, `$xprepare`/`$xreceive`/`$xcommit` a cross-shard trade through it,
exactly as in §7.

**`$unwrap`** is the holder's own step — burn, self-identified on-chain (via
`rho:rev:address`, never a caller-supplied string, so nobody can name someone
else's balance), recording a permanent redemption claim:

```
Alice ▸ $unwrap(rho:id:wrap7…, 3, "claim1")
        ✓ → ("burned", "claim1", 3)
```

**`$wrelease`** is the issuer's separate redemption step, honoring that
claim — Alice's own `revVault` transfer to the holder, chained with marking
the claim released:

```
Alice ▸ $wrelease(rho:id:wrap7…, "claim1", myRevAddr, 3)
        ✓ → ("released", "claim1", 3, "myRevAddr…")
```

Two macros because they're two different parties' actions, possibly at
different times — burning doesn't force the issuer's hand, and the issuer
can't release a claim that wasn't made.

**Trust.** A wrapped token is worth par only if the issuer honors
`$wrelease` — the same assumption as a personal currency or any `/note`
currency. `$winfo` reports the issuer, backing address, base currency and
supply, so anyone can `$balance(backingAddr)` and compare it against supply
themselves — public verifiability, not enforcement:

```
▸ $winfo(rho:id:wrap7…)
  → {"issuer": …, "backingAddr": "myRevAddr…", "baseCurrency": "REV", "supply": 7}
```

If an issuer stiffs a redemption, the `claims` record is permanent on-chain
evidence for `/gov censure`; making the issuer a `/gov` group rather than a
person is the mitigation for anything beyond small value. The machinery
cannot force a `revVault` transfer — that is the honest cost of never
touching it. **Fungibility:** `w<BASE>~<issuer8>` — non-fungible across
issuers, the same shape as a terms-stamped `/note` series.

**The full path, native REV (shard A) → native FOO (shard B):**

```
$wrap  10 REV          → 10 wREV~a         (shard A, Alice's issuer, edge)
$xprepare / $xreceive  → cross-shard 2PC   (the atomic part, §7)
$xcommit × 2            → 78 wFOO~b landed on shard B
$unwrap 78 wFOO~b       → 78 FOO            (shard B, Paris's issuer, edge)
```

Only the middle step is the cross-shard atomic part; wrap/unwrap are
single-shard and never leave their shard. Verified end to end against
localnet: wrap → mint → burn → release, and the full round trip through a
2PC trade.

---

## 7. Federation — a trade that hops shards, atomically

Alice's exchange is on shard A. A **Paris** exchange runs on shard B with a
BobBucks–GBP pool. The two federate by recording each other, **on both
sides**:

```
Alice ▸ $xlink(rho:id:9xm7c…, "ALICE-BOB", "toParis", rho:id:paris…, "shard-B")
        ✓ → ["linked", "toParis"]

Paris  ▸ $xlink(rho:id:paris…, "BOB-GBP", "toAlice", rho:id:9xm7c…, "shard-A")
        ✓ → ["linked", "toAlice"]
```

Each side declares its own trust — `prepareReceive` only extends credit
against a link the *receiving* pool itself recorded (§"Why prepareReceive
trusts a link" below), so this is deliberate, not automatic.

Now Bob wants AliceCoin (shard A) → GBP (shard B) in one atomic trade. This
is a **client-driven two-phase commit** — every call below uses Bob's own
key (a `deployerId` is shard-independent, so the Paris pool sees Bob's real
identity — [`CapabilityTransport.md`](CapabilityTransport.md) Layer 1):

```
Bob ▸ txId = a fresh random id, say "t42"

Bob ▸ $xprepare(rho:id:9xm7c…, "ALICE-BOB", "t42", A, 100, 999999)
      ✓ → ("prepared", "t42", 50, "B", 999999)
      (shard A: Bob's balance and reserves already moved, as a "swap" would —
       but held as a reversible tx record, not yet final)

Bob ▸ $xreceive(rho:id:paris…, "BOB-GBP", "t42", A, 50, 999999, "toAlice")
      ✓ → ("prepared", "t42", 42, "B", 999999)
      (shard B, over a remote signed deploy — Paris credits 50 BobBucks "as if
       deposited" and swaps it to 42 GBP, held the same reversible way)

Bob ▸ $xcommit(rho:id:9xm7c…, "t42")
      ✓ → ("committed", "t42", 50, "B")
Bob ▸ $xcommit(rho:id:paris…, "t42")
      ✓ → ("committed", "t42", 42, "B")
```

Bob now holds 42 GBP in his Paris balance, withdrawable like any other.

**If the remote leg refuses** (no such link, insufficient reserve, or Bob
never gets to call it — a lost connection, a crash) — nothing has moved:

```
Bob ▸ $xabort(rho:id:9xm7c…, "ALICE-BOB", "t42")
      ✓ → ("aborted", "t42")
      (shard A: reserves and Bob's balance revert exactly to pre-prepare)
```

Verified end to end against localnet, both the happy path and this abort
path, across two separate exchange deployments (a real simulation of two
shards, not one contract standing in for both).

**Recovery, if Bob's client crashes mid-flight.** Both legs are gated to
*Bob's own key* throughout, so recovery needs no counterparty — Bob (or his
client, reconnecting) reads `$xstateof` on both legs and follows a fixed
recovery table ([`exchange-2pc.ts`](https://github.com/rchain-community/quantum-os/blob/main/packages/browser/src/exchange-2pc.ts)
for the curious): both
`prepared` → finish committing both; one `prepared`, the other never
happened → abort the one that ran; either side already `committed` → finish
the other (idempotent). This is why **`commit`/`abort` are gated to the tx's
own holder** rather than open to anyone — the same identity drives both legs
and can always finish the job.

> **Known gap — `abort` is self-only in this version** ([#198](https://github.com/rchain-community/quantum-os/issues/198)). A permissionless
> after-expiry path is designed (`expiryBlock` is recorded on every tx) but
> not implemented: verified empirically that reading `rho:block:data` from a
> *signed deploy* breaks this rnode build's return-value readback — even for
> the simplest possible program, with no rholang error either. So a trade
> abandoned by its own key (lost seed, browser gone for good) stays
> `prepared` — locked, not lost, recoverable only by that same key
> reappearing. See `CapabilityTransport.md`.

**Why `prepareReceive` trusts a link, not a proof.** Shard B cannot read
shard A's state directly — that is the reason two-phase commit exists at
all, not a gap in it. `prepareReceive` checks only that *this* pool has a
`link` entry by the name given; it does not (cannot) verify the matching
`prepare` on the far shard is real. This is sound because linked pools share
an operator — the federation is trusting its own two pools, not a stranger's
claim. Each pool still never pays out more than its own reserve, so the
worst a bad-faith caller can do is strand one leg until it's `abort`ed —
never drain a pool.

---

## 8. Connecting a quantum-os `/note` currency

A `/note` currency (`cap:token-USD:…` / `cap:note-USD:…`) is a **bearer label**
with no chain presence — it lives entirely in the room, same as before §1's
currencies gained a token contract. To trade it on the exchange it needs the
same kind of on-chain **token contract** §1 built — `$winstall` works for
this too, or any contract with a `transfer` method that moves the unit
between addresses. Its `rho:id:…` URI is then what you pass as `tokenA` /
`tokenB` to `$xopen`, and what you'd record on the currency's
`KnownCurrency` entry so the room knows where it trades. The exchange never
calls that contract itself — holders move the token in and out around their
`deposit` / `withdraw`.

Wiring the `KnownCurrency.exchange` field + a `/note` subcommand to record
the pool automatically is a small follow-up — the exchange itself is
agnostic: it moves messages to whatever `token` URI you name.

---

## Honest scope

- **A personal currency (§1) has no P2P transfer yet** — the issuer can
  `$mint` to anyone directly, and a holder can `$unwrap`/burn their own
  balance, but there is no way to hand a balance to someone else without
  going through the issuer or the exchange. A general transfer verb is a
  natural follow-up.
- **Fixed rate, not an AMM.** The rate is set by the owner and changes only
  with `setRate`. No constant-product curve, no slippage, no impermanent loss —
  and no automatic price discovery. An owner who mis-prices a pool can be
  arbitraged until a reserve empties (then `swap`/`prepare` return
  `insufficient reserve`, not a bad fill).
- **Capability security is the proof.** The contract exposes no method that
  pays the operator and holds no capability that drains a pool outside the
  rate. There is nothing to corrupt because there is no ambient authority.
- **The exchange is an accountant.** It tracks balances and reserves; the token
  contracts move the actual tokens. A `deposit` you never funded, or a
  `withdraw` you never move out, is your own inconsistency to reconcile.
- **Cross-shard trades are safety-atomic, not instant-atomic.** Two-phase
  commit means either both legs settle or the prepared one reverts exactly —
  never a state where value is lost or a party is shorted — but it is still
  two transactions with a window between them, not one.
- **`abort` is self-only in this version** — no on-chain permissionless
  timeout (§7's known gap). A trade abandoned by its own key stays locked,
  not lost, until that key returns.
- **`prepareReceive` trusts a `link`, not a cryptographic proof** — sound
  because linked pools share an operator, not because it's verified (§7).
- **A wrapped token is only as good as its issuer's `$wrelease`** — the same
  trust as a personal currency or any `/note` currency; `$winfo` makes the
  backing publicly checkable, it doesn't enforce it.
- **The rholang is shape-checked in CI and verified end to end against
  localnet**, not formally proven.

---

## Related

- [`CapabilityTransport.md`](CapabilityTransport.md) — Layer 1 (the cross-shard remote signed deploy `prepareReceive` uses) and Layer 2.
- [`PromissoryNoteDemo.md`](PromissoryNoteDemo.md) — quantum-os `/note` currencies (the bearer side).
- [`AtomicSwapDemo.md`](AtomicSwapDemo.md) — `/rdv swap`, the in-room atomic 2-party trade (no rholang, no rate).
- [`MacRhoLang.md`](MacRhoLang.md) — the `$` macro layer.
- rchain-community/rchain-rust#33 — the linked-invoke primitive `prepareReceive` builds on.

---

## Found a gap, or want a new capability?

A P2P transfer for a personal currency (§1's known gap), multi-hop routing
past two pools, an AMM-style rate curve, a `KnownCurrency` field so a
`/note` currency remembers where it trades, the on-chain
permissionless-after-expiry `abort` (§7's known gap —
[already tracked, #198](https://github.com/rchain-community/quantum-os/issues/198)) —
none of this is closed. **[Open an issue →](https://github.com/rchain-community/quantum-os/issues/new)**
and say what you hit or what you'd want; that's exactly how this exchange
went from a single pool to atomic federation and wrapped native tokens.

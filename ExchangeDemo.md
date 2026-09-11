# A Token Exchange in Rholang

A walkthrough of the pooled token exchange in [quantum-os](README.md): deploy a
pool, seed it, trade against it, and **federate** two exchanges across shards so
a trade can hop between them — atomically. Actors: **Alice** runs an exchange
on shard A, **Bob** trades, and a **Paris** exchange runs on shard B.

Everything below is one line each, typed into a [quantum-os](README.md) room
after `/rholang key generate` (or an existing funded key) — `$xinstall()`
deploys a fresh exchange, and the rest are ordinary `$name(…)` macro calls,
no `/` command of their own. (For the curious: the contract itself is
[`rholang-exchange.js`](https://github.com/rchain-community/quantum-os/blob/main/packages/browser/src/rholang-exchange.js),
the macros are registered in
[`rholang-macros.js`](https://github.com/rchain-community/quantum-os/blob/main/packages/browser/src/rholang-macros.js) —
neither needs reading to follow this walkthrough.)

> **No platform token, directly.** The exchange never touches
> `rho:rchain:revVault`. It trades tokens by their *own contract URIs*; REV
> cannot be pooled or moved by this machinery. REV (or any chain's native
> token) still trades — **wrapped** (§6) — which is where the one sanctioned
> `revVault` touch in this whole design lives, at the edge, in the issuer's
> own deploy. This is the same rule as the rest of `CapabilityTransport.md`.

---

## The model

A **pool** trades one ordered token pair `(A, B)` at an **owner-set fixed
rate**. The rate is fixed-point: `rate` units of B per `1e6` units of A. So
`rate = 920000` means 0.92 B per A.

```
pool "USD-EUR"
  ├─ owner      *deployerId of whoever ran "open"
  ├─ tokenA     rho:id:…usd…      (the token's own contract)
  ├─ tokenB     rho:id:…eur…
  ├─ rate       920000            (0.92 EUR per USD, ×1e6)
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
| `abort(txId)` | the tx's own holder | reverse a prepared tx exactly (idempotent; self-only — see §5) |
| `stateOf(txId)` | anyone (read) | a tx's status — the recovery primitive |

Thirteen of these fourteen have a `$x*` macro (`$xopen` `$xprovide`
`$xdeposit` `$xquote` `$xswap` `$xwithdraw` `$xlink` `$xinspect` `$xprepare`
`$xreceive` `$xcommit` `$xabort` `$xstateof`), plus `$xinstall()` to deploy
the exchange itself in the first place; `setRate` is called through the raw
`setRateProgram` builder or a hand-written `/rholang deploy`.

---

## 1. Alice deploys an exchange

Alice needs a signing key with REV for phlo (`/rholang key generate`, funded on
her shard). One macro installs the contract; its answer is the exchange URI
every later call resolves through.

```
Alice ▸ $xinstall()
        ✓ Success!  → rho:id:9xm7c…iwwjuio
```

She records `rho:id:9xm7c…` — the **exchange URI**. Anyone she gives it to can
open pools and trade; only the pool's own `open`er can `provide` / `setRate` /
`link` it.

---

## 2. Open the USD–EUR pool

```
Alice ▸ $xopen(rho:id:9xm7c…, "USD-EUR", rho:id:usd, rho:id:eur, 920000)
        ✓ → rho:id:4z9p3…            (the pool's cap — a receipt of ownership)
```

`rho:id:usd` and `rho:id:eur` are the two currencies' **own token contracts**
(see §7 for how a quantum-os `/note` currency gets one; §6 for a native token
like REV). The rate `920000` is 0.92 EUR per USD.

---

## 3. Alice seeds liquidity

Alice moves 1000 EUR into the exchange with EUR's own `transfer`, then records
it as pool reserve:

```
Alice ▸ $xprovide(rho:id:9xm7c…, "USD-EUR", B, 1000)
        ✓ → 1000                    (reserveB)
```

Now the pool can pay out up to 1000 EUR of swaps.

---

## 4. Bob trades USD → EUR

Bob has USD. He moves 100 USD into the exchange (USD's `transfer`) and records
it:

```
Bob ▸ $xdeposit(rho:id:9xm7c…, "USD-EUR", A, 100)
      ✓ → 100                       (Bob's in-pool balance: {a: 100, b: 0})
```

He checks the price, then swaps:

```
Bob ▸ $xquote(rho:id:9xm7c…, "USD-EUR", A, 100)      (a read — no phlo, no block)
      → {"toSide": "B", "out": 92}

Bob ▸ $xswap(rho:id:9xm7c…, "USD-EUR", A, 100)
      ✓ → {"gave": 100, "got": 92, "toSide": "B"}
```

Bob's balance is now `{a: 0, b: 92}`; the pool's reserves moved to
`reserveA: 100, reserveB: 908` — conserved. Bob withdraws his EUR:

```
Bob ▸ $xwithdraw(rho:id:9xm7c…, "USD-EUR", B, 92)
      ✓ → {"withdraw": 92, "side": "B", "left": 0}
```

…then moves 92 EUR out of the exchange with EUR's `transfer`. The exchange is
an accountant, not a custodian of last resort: it records who is owed what, and
the token contracts do the actual moving.

---

## 5. Federation — a trade that hops shards, atomically

Alice's exchange is on shard A. A **Paris** exchange runs on shard B with an
EUR–GBP pool. The two federate by recording each other, **on both sides**:

```
Alice ▸ $xlink(rho:id:9xm7c…, "USD-EUR", "toParis", rho:id:paris…, "shard-B")
        ✓ → ["linked", "toParis"]

Paris  ▸ $xlink(rho:id:paris…, "EUR-GBP", "toAlice", rho:id:9xm7c…, "shard-A")
        ✓ → ["linked", "toAlice"]
```

Each side declares its own trust — `prepareReceive` only extends credit
against a link the *receiving* pool itself recorded (§"Why prepareReceive
trusts a link" below), so this is deliberate, not automatic.

Now Bob wants USD (shard A) → GBP (shard B) in one atomic trade. This is a
**client-driven two-phase commit** — every call below uses Bob's own key
(a `deployerId` is shard-independent, so the Paris pool sees Bob's real
identity — [`CapabilityTransport.md`](CapabilityTransport.md) Layer 1):

```
Bob ▸ txId = a fresh random id, say "t42"

Bob ▸ $xprepare(rho:id:9xm7c…, "USD-EUR", "t42", A, 100, 999999)
      ✓ → ("prepared", "t42", 92, "B", 999999)
      (shard A: Bob's balance and reserves already moved, as a "swap" would —
       but held as a reversible tx record, not yet final)

Bob ▸ $xreceive(rho:id:paris…, "EUR-GBP", "t42", A, 92, 999999, "toAlice")
      ✓ → ("prepared", "t42", 78, "B", 999999)
      (shard B, over a remote signed deploy — Paris credits 92 EUR "as if
       deposited" and swaps it to 78 GBP, held the same reversible way)

Bob ▸ $xcommit(rho:id:9xm7c…, "t42")
      ✓ → ("committed", "t42", 92, "B")
Bob ▸ $xcommit(rho:id:paris…, "t42")
      ✓ → ("committed", "t42", 78, "B")
```

Bob now holds 78 GBP in his Paris balance, withdrawable like any other.

**If the remote leg refuses** (no such link, insufficient reserve, or Bob
never gets to call it — a lost connection, a crash) — nothing has moved:

```
Bob ▸ $xabort(rho:id:9xm7c…, "USD-EUR", "t42")
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

## 6. Wrapped native tokens — trading REV itself

The exchange never touches `revVault` (top of this doc) — so REV participates
only as a **wrapped** token. Alice issues one:

```
Alice ▸ $winstall(myRevAddr, "REV")
        ✓ Success!  → rho:id:wrap7…      (the wrapper URI; Alice is the issuer)
```

**`$wrap` — the one macro in this whole design that touches `revVault`,**
because it's Alice's own sanctioned deploy: a real REV transfer to the
wrapper's backing address, then mint — chained in one program, so there is
no window where REV moved but nothing was minted (or vice versa):

```
Alice ▸ $wrap(rho:id:wrap7…, myRevAddr, 10, myRevAddr)
        ✓ → ("minted", 10, "myRevAddr…", 10)
```

Now `rho:id:wrap7…` is a token like any other — `$xopen` a `wREV-wFOO` pool
with it, `$xprepare`/`$xreceive`/`$xcommit` a cross-shard trade through it,
exactly as in §5.

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
`$wrelease` — the same assumption as any `/note` currency. `$winfo` reports
the issuer, backing address, base currency and supply, so anyone can
`$balance(backingAddr)` and compare it against supply themselves — public
verifiability, not enforcement:

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
$xprepare / $xreceive  → cross-shard 2PC   (the atomic part, §5)
$xcommit × 2            → 78 wFOO~b landed on shard B
$unwrap 78 wFOO~b       → 78 FOO            (shard B, Paris's issuer, edge)
```

Only the middle step is the cross-shard atomic part; wrap/unwrap are
single-shard and never leave their shard. Verified end to end against
localnet: wrap → mint → burn → release, and the full round trip through a
2PC trade.

---

## 7. Connecting a quantum-os `/note` currency

A `/note` currency (`cap:token-USD:…` / `cap:note-USD:…`) is a **bearer label**
with no chain presence — it lives entirely in the room. To trade it on the
exchange it needs an on-chain **token contract** (something with a `transfer`
method that moves the unit between addresses), published to the registry. Its
`rho:id:…` URI is then what you pass as `tokenA` / `tokenB` to `$xopen`, and
what you'd record on the currency's `KnownCurrency` entry so the room knows
where it trades. The exchange never calls that contract itself — holders move
the token in and out around their `deposit` / `withdraw`.

Deploying that token contract per currency, and the `KnownCurrency.exchange`
field + a `/note` subcommand to record the pool, are a small follow-up — the
exchange itself is agnostic: it moves messages to whatever `token` URI you name.

---

## Honest scope

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
  timeout (§5's known gap). A trade abandoned by its own key stays locked,
  not lost, until that key returns.
- **`prepareReceive` trusts a `link`, not a cryptographic proof** — sound
  because linked pools share an operator, not because it's verified (§5).
- **A wrapped token is only as good as its issuer's `$wrelease`** — the same
  trust as any `/note` currency; `$winfo` makes the backing publicly
  checkable, it doesn't enforce it.
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

Multi-hop routing past two pools, an AMM-style rate curve, a `KnownCurrency`
field so a `/note` currency remembers where it trades, the on-chain
permissionless-after-expiry `abort` (§5's known gap —
[already tracked, #198](https://github.com/rchain-community/quantum-os/issues/198)) —
none of this is closed. **[Open an issue →](https://github.com/rchain-community/quantum-os/issues/new)**
and say what you hit or what you'd want; that's exactly how this exchange
went from a single pool to atomic federation and wrapped native tokens.

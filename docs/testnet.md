# Testnet — `testnet.rhobot.net`

A small public RChain testnet run on [rchain-rust](../) for the rholang playground, the room
agents and experiments. Two bonded validators on two hosts, funded dev wallets, and an **idle**
chain that produces a block only when a deploy arrives.

> **Status: reads, writes and validator onboarding all work — verified end to end.** A brand-new key
> can be funded by transfer, deploy, be trusted, and bond into the validator pool (transcript in
> [Status](#status-of-the-verified-path)). `/api/status`, `/api/explore-deploy`, `getBonds`,
> `getActiveValidators`, `/health`, and `rnode deploy` with no extra flags all work. The chain is
> deliberately **idle** (no `--autopropose`): blocks appear when a deploy arrives. A
> continuously-producing chain cannot be restarted on a 1 GB host — that is what broke the previous
> chain, and it is [K7](#known-issues), the most important operational constraint here. Not
> production, holds no value, and its chain can be reset at any time.

---

# Part 1 — For users

## What it is

| | |
|---|---|
| Chain | `testnet` network id, shard `/root`, genesis `26bf2328…19a9` |
| Validators | node A (`d3cc3442…`, stake **1000**) + node B (`ec923454…`, stake 100) |
| Hosts | A `164.90.140.144` (private `10.108.0.3`), B `104.131.176.164` (private `10.108.0.4`) |
| Cost | 2 × DigitalOcean `s-1vcpu-1gb`, **$12/mo** |
| Binary | rchain-rust `dev` (deploy-anchor fix merged as #58), static musl `d7f5000b…`, on all three hosts |
| Endpoint | **https://testnet.rhobot.net** (nginx → node A's HTTP API) |

A's stake is 1000 against B's 100 on purpose: with no `--autopropose`, A is the only proposer, so A
must hold **more than ⅔ of the whole bond pool** (including any stake sitting in withdrawal
quarantine) or no block is ever finalised. That is what keeps A able to finalise after observers bond.

## Connect

```
/rholang rnode https://testnet.rhobot.net      # the playground's node selector
```

Directly, if you prefer:

```
GET  http://164.90.140.144:40403/api/status            # public HTTP API
POST http://164.90.140.144:40403/api/explore-deploy    # eval a term (read-only)
GET  https://testnet.rhobot.net/health                 # health snapshot (JSON)
POST http://164.90.140.144:40405/api/v1/propose        # admin: force a block
```

Ports `40400` (protocol) and `40404` (discovery) are open on both nodes; `40401`, `40403` and
`40405` are open on both for clients.

## Keys and funds

Genesis funds the standard dev keys from `scripts/localnet/pk.txt` with 1,000,000,000,000 each,
so anything already wired to those keys works unchanged:

| key | REV address |
|---|---|
| `deployer` (`3554e876…`) | the facilitator faucet's key |
| `dave` (`7707a3e0…`) | `1111pJu4TJaJDNJDTinnftr2fcHvMfnDeTRXRzwgPfwuKmGMa5juj` |
| `alice`, `bob`, `carol` | see `wallet.txt` |

These are throwaway development keys, published on purpose. Never use them for anything real.

## What works today

| | |
|---|---|
| `eval` / `explore-deploy` | ✅ works — the full Rholang/QLF macro surface |
| Reads of chain state (`getBonds`, `getActiveValidators`) | ✅ works |
| `GET /api/status` | ✅ works |
| `/health` monitoring snapshot | ✅ works |
| **Deploys — browser, room agents, `rnode deploy` CLI** | ✅ works (the CLI needed `--valid-after-block-number` before the 2026-09-21 binary — K1) |
| Transfers, including funding a brand-new key | ✅ verified: a fresh key's balance went `0` → `100000000000`, and it could then deploy |
| **Becoming a validator** | ✅ verified end to end: `trust` → `(true)`, `bond` → `(true)`, bond pool 2 → 3, active set 3 |

## Monitoring

`https://testnet.rhobot.net/health` is refreshed every 60 seconds by each node and answers with
that node's snapshot (node A's, since nginx fronts A):

```json
{ "host": "testnet-a", "ok": true, "rnode_unit": "active", "api_reachable": true,
  "blocks": 6, "blocks_since_last_tick": 0, "peers": 1, "nodes": 1,
  "finalized_fringe": false, "autopropose": false,
  "mem_available_mb": 627, "disk_free_mb": 22665 }
```

`ok: false` means the unit is down, the API is unreachable, or the height is zero. **`finalized_fringe:
false` is expected here and is not a failure** — this chain is idle, and nothing is finalised while no
blocks are produced. Joining nodes still sync: they restore from the *approved genesis* fringe, which
was verified twice with node B. DigitalOcean's dashboard also graphs CPU/RAM/disk for both hosts
(`do-agent`).

## Limits to expect

- **Idle chain, by design.** No `--autopropose` and no injected dummy deploy: a block is produced
  when a deploy arrives (`--propose-on-deploy`). Heights stay put while nobody is doing anything.
- **A rebuild resets everything.** Changing `bonds.txt`/`wallets.txt` means a new genesis and a new
  chain.
- Disk now grows with real usage only (~6.6 KB per block) instead of ~140 MB/day.
- **Start-up is the expensive part.** Replay costs about **0.25 MB of RAM and ~0.2 s per existing
  block** before the API opens at all (a 1142-block chain: ~285 MB, ~3.5 minutes), while *producing*
  blocks is nearly free. Budget ≥2 GB for ~1k blocks, ≥4 GB to be comfortable — see
  [K7](#known-issues) and [rchain-rust#60](https://github.com/rchain-community/rchain-rust/issues/60).
- No SLA, no backups of chain state beyond the genesis files.

---

# Part 2 — For maintainers

## Upstream references

The node-level knowledge in this document also lives in `rchain-rust` `dev`, where node contributors will
find it. Where the two overlap, prefer the upstream text: this document is the runbook for **this** net —
our hosts, keys, genesis, health checks and the incident record (K1–K7).

| upstream | what lives there |
|---|---|
| [`docs/src/node/running-a-public-testnet.md`](https://github.com/rchain-community/rchain-rust/blob/dev/docs/src/node/running-a-public-testnet.md) | the generalised procedure: stake split, genesis ceremony, joining, admitting a validator to a running chain, monitoring, sizing, rebuilds |
| [`docs/src/node/operating.md`](https://github.com/rchain-community/rchain-rust/blob/dev/docs/src/node/operating.md#deploying-and-block-production) | `--shard-id`, the deploy-anchor rule, reading a term's return value, the three block production modes, finality/withdraw behaviour |
| [`docs/src/node/validator-requirements.md`](https://github.com/rchain-community/rchain-rust/blob/dev/docs/src/node/validator-requirements.md) | host sizing, including the start-up replay floor (K7) |
| [#60](https://github.com/rchain-community/rchain-rust/issues/60) | the start-up replay issue: measurements, a reproduction, and what is still unattributed |
| [#39](https://github.com/rchain-community/rchain-rust/issues/39) | the validator lifecycle; this net's verified transcript is posted there |

The deploy-anchor fix (K1) reached `dev` as
[#58](https://github.com/rchain-community/rchain-rust/pull/58), and the three docs above came in as
[#61](https://github.com/rchain-community/rchain-rust/pull/61).

## Topology

```
testnet.rhobot.net ──► node A 164.90.140.144 (10.108.0.3)   genesis master, stake 1000
                        └─ nginx + Let's Encrypt (cert to 2026-12-20), /health from a timer
                        └─ rnode: -s --dev-mode --propose-on-deploy  (NO --autopropose)
                       node B 104.131.176.164 (10.108.0.4)   joining validator, stake 100
                        └─ rnode: --dev-mode --propose-on-deploy --bootstrap A  (no -s)
```

Both live in the `default-nyc3` VPC, the same one as rhobot-2, so they can also talk over
private addresses (`10.108.0.0/20`).

**Why 1000/100, and why no `--autopropose`.** Both were learned by breaking it:

1. **Finality needs >⅔ of the whole pool, and A is the only proposer.** At 300/100 the chain
   finalised fine — right up until an observer bonded 100, which took A to 60% and stopped finality
   dead. `withdraw` is not an immediate escape either: the stake is escrowed until the quarantine
   deadline, so it goes on diluting the pool. 1000 tolerates about four joiners at stake 100.
2. **The previous chain outgrew the host.** It ran `--autopropose` plus an injected dummy deploy,
   about one block every 2.5 s. Start-up replay costs roughly **0.25 MB and ~0.2 s per existing block**
   before the API opens at all, so by ~1140 blocks every restart needed ~285 MB plus minutes of silence,
   on a 957 MB host that was also running nginx and do-agent: the kernel OOM-killed rnode, the next start
   replayed the same DAG and died again, and the API never came up (K7 — the "unresponsive API" symptom,
   which is *not* the injector). Omitting `--autopropose` and `--deployer-private-key` makes blocks arrive
   only when deploys do, keeping restart cost proportional to real usage. Generalised sizing guidance is
   upstream in
   [`docs/src/node/validator-requirements.md`](https://github.com/rchain-community/rchain-rust/blob/dev/docs/src/node/validator-requirements.md).

## Genesis

Built once with `scripts/localnet/keys.mjs`; the exact files are on each node:

```
/var/lib/rnode/genesis/bonds.txt    2 lines: <65-byte pubkey> <stake>  (A 1000, B 100)
/var/lib/rnode/genesis/wallets.txt  6 funded REV addresses (the dev keys)
/etc/rnode/validator.key            that node's validator key (0600 rnode:rnode)
/etc/rnode/deployer.env             DEPLOYER_PRIVATE_KEY=… (kept on disk, now unused: no injector)
```

Genesis hash `26bf2328190ab2d7b580a868e63cd71b34c8a7a33a89ecbff19f9c8abb8819a9`; A's node id
`d3cc3442ebcbc633edf950b579caf3f0a259ac76`, B's `ec92345441deaf20250e881fe890c65e1a596b7f`.

Both nodes start with `--pos-multi-sig-public-keys <dave's pubkey> --pos-multi-sig-quorum 1`, which
puts **dave** — a `wallets.txt`-funded key that can actually pay phlo — into the trusted set at
genesis. That is what makes live admission possible (K6): dave is the key that can `trust` others.
Give the same list to every node, or a joiner's own view of the genesis PoS spec will not match the
chain it is joining.

Bond parameters come from defaults: `--bond-minimum 1`, `--bond-maximum 100`,
`number_of_active_validators 10`. **10 is larger than the bond pool**, so every properly bonded
validator is active — no top-N truncation to reason about.

`--validator-private-key-path` (a file, not a flag value) works because the fix merged
2026-09-21; on older binaries it is silently ignored and the key must be passed inline.

## Operating the nodes

```bash
systemctl {status,restart,log} rnode            # the node
systemctl list-timers rnode-health.timer        # monitoring
journalctl -t rnode-health -n 20                # health warnings only
```

Rebuild / re-key (the whole network):

```bash
# on the master
rnode --profile docker run -s --dev-mode --propose-on-deploy --no-upnp --host <ip> \
  --data-dir /var/lib/rnode \
  --bonds-file /var/lib/rnode/genesis/bonds.txt \
  --wallets-file /var/lib/rnode/genesis/wallets.txt \
  --pos-multi-sig-public-keys <dave pubkey> --pos-multi-sig-quorum 1 \
  --validator-private-key-path /etc/rnode/validator.key
# a joining validator: same flags minus -s, plus --bootstrap, and its own validator key
```

There is **no `--no-autopropose` flag** — you omit `--autopropose`. (`tools/devnet.sh` accepts
`--no-autopropose` because that is *its* CLI; it only omits the node flag.) Passing it makes the
node exit 1 in a restart loop. The production-mode matrix and the finality consequences of an idle chain
are upstream in
[`docs/src/node/operating.md`](https://github.com/rchain-community/rchain-rust/blob/dev/docs/src/node/operating.md#block-production-modes).

## Adding a node (observer)

An observer is any node without a bonded key. It replicates the chain and can be started
anywhere:

```bash
rnode --profile docker run --host <its-ip> --data-dir /var/lib/rnode \
  --pos-multi-sig-public-keys <dave pubkey> --pos-multi-sig-quorum 1 \
  --bootstrap rnode://d3cc3442ebcbc633edf950b579caf3f0a259ac76@164.90.140.144?protocol=40400&discovery=40404
```

(The multi-sig flags must match the genesis master's, or the joiner's own view of the genesis PoS
spec will not match — see [Genesis](#genesis).)

Success looks like this in the log — note the LFS step, which restores from the **approved genesis**
fringe. That is why joining works even though this idle chain has no *last-finalised* fringe:

```
INFO [casper.engine.NodeSyncing] Blocks for approved state added to DAG.
INFO [casper.engine.NodeSyncing] LFS state is successfully restored.
INFO [casper.engine.NodeLaunch] Making a transition to Running state.
```

A join takes about 15 seconds and ~19 MB, measured.

## Onboarding an observer into the validator pool

The generalised procedure — the admission routes, the funding prerequisites and a verified transcript — is
upstream in
[`docs/src/node/running-a-public-testnet.md`](https://github.com/rchain-community/rchain-rust/blob/dev/docs/src/node/running-a-public-testnet.md).
What follows is this net's version, with the keys and addresses actually in play here.

The implementation models the full lifecycle natively (`rholang/src/native_state.rs`):

> **observer** — any key that is not bonded · **trusted** — admission into the validator
> stakeholder group; only a trusted key may bond · **bonded / pool** — a bond within
> `[minimum, maximum]`, deducted from the validator's REV vault · **active** — the consensus set:
> the top `number_of_active_validators` of the pool by stake, recomputed on every membership
> change · **withdrawing** — deactivation, stake escrowed until the quarantine deadline ·
> **removed** — `slash`/`untrust`, stake confiscated.

Bonding is done through the `rho:rchain:pos` **system process** (native methods `bond`,
`withdraw`, `trust`, `untrust`, `getBonds`, `getActiveValidators`). There is no CLI or HTTP
endpoint for it: it is a deploy. `bond` takes the *caller's own* `rho:rchain:deployerId` as an
unforgeable capability, so **a key can only bond itself** — nobody can bond it on its behalf.

`native_state.rs::bond` enforces, in order:

| check | failure string |
|---|---|
| not already in pool/active | `Public key is already bonded.` |
| **is trusted** | `Validator is not trusted: observer admission is required before bonding.` |
| `minimum ≤ stake ≤ maximum` | `Bond is less than minimum (…)` / `greater than maximum (…)` |
| `vault_balance ≥ stake` | `insufficient funds to bond … (have …)` |

### Two admission routes

**(a) At genesis** — `bonds.txt`, plus `--pos-multi-sig-public-keys` to pre-trust keys that are
not themselves bonded. `trusted` is seeded as *genesis bond keys ∪ that list*. Changing either
means a **new genesis and a new chain**.

**(b) Live, on a running chain** — a trusted key confers trust, then the newcomer bonds:

```
1. a trusted key deploys        pos!("trust", *deployerId, "<newcomer 65-byte pubkey>".hexToBytes(), *ret)
2. the newcomer deploys         pos!("bond",  *deployerId, <stake>, *ret)      # 1..100 here
```

Two funding prerequisites, both easy to miss and both **verified working here** (the general form, with
the reasoning, is upstream):

- the **trusting key must hold REV**, because it pays for the `trust` deploy's phlo from its own vault. A
  genesis-trusted key that is not in `wallets.txt` cannot deploy at all — which is why **dave** is the
  trusted key on this net (see K6);
- the **newcomer must hold REV ≥ stake**, because the bond is deducted from its vault.

Funding either one is an ordinary transfer, and a vault balance is readable with `getBalance` — **not**
`balance`. The terms this net uses are below.

### The exact terms

Every term must bind the names it uses — a raw deploy/eval does **not** get `return` for free
(the browser and macro path adds it via `wrapProgram`, which merges
`new return, stdout(\`rho:io:stdout\`), …zfa/grant/verify/fuse… in { … }`). Omitting it fails
with `Top level free variables are not allowed`.

```
// read the pool (works today)
new return, pos(`rho:rchain:pos`), ret in {
  pos!("getBonds", *ret) | for (@b <- ret) { return!(b) }
}
// → {"expr":[{"ExprMap":[["0410b8c5…0c3c73",{"ExprInt":1000}],["04675f16…514404",{"ExprInt":100}]]}]}

// read the consensus set (works today)
new return, pos(`rho:rchain:pos`), ret in {
  pos!("getActiveValidators", *ret) | for (@v <- ret) { return!(v) }
}
// → {"expr":[{"ExprSet":[{"ExprBytes":"0410b8c5…"},{"ExprBytes":"04675f16…"}]}]}

// confer trust on a newcomer (deploy signed by a trusted, funded key)
new return, pos(`rho:rchain:pos`), deployerId(`rho:rchain:deployerId`), ret in {
  pos!("trust", *deployerId, "<65-byte hex pubkey>".hexToBytes(), *ret) |
  for (@r <- ret) { return!(r) }
}

// bond yourself (deploy signed by the newcomer; stake 1..100)
new return, pos(`rho:rchain:pos`), deployerId(`rho:rchain:deployerId`), ret in {
  pos!("bond", *deployerId, 100, *ret) | for (@r <- ret) { return!(r) }
}

// withdraw (deactivates immediately; stake escrowed until the quarantine deadline)
new return, pos(`rho:rchain:pos`), deployerId(`rho:rchain:deployerId`), ret in {
  pos!("withdraw", *deployerId, *ret) | for (@r <- ret) { return!(r) }
}
```

Deploy them with:

```bash
rnode --profile docker deploy --phlo-limit 90000 --phlo-price 1 --shard-id /root \
  --private-key <hex> term.rho
rnode --profile docker deploy-status --deploy-signature <deployId>
```

Two easy-to-miss details:

- `--shard-id /root`, or the node answers
  `Deploy shardId '' is not a member of this node's shards: [/root]`;
- `--valid-after-block-number <current height>` **only on a binary built before 2026-09-21** — the
  current testnet binary is anchored at the node's height automatically (K1). If `deploy-status`
  answers `notProcessed / Unknown`, the deploy was swept from the pool as expired.

### Status of the verified path

Everything below was run against this chain, with the deploys signed through
`scripts/qos-cli/rholang-client.mjs` (which wraps each term in a result slot, so the term's *return
value* is readable) and with dev's registry-lookup fix in the running binary:

| step | result |
|---|---|
| `getBonds` / `getActiveValidators` reads | ✅ |
| fund a brand-new key: `getBalance` → transfer 1e11 → `getBalance` | ✅ `0` → `100000000000` |
| the new key deploys `return!(1)`, no flags | ✅ value `"1"` |
| **a trusted key deploys `pos!("trust", …)` for it** | ✅ value **`(true)`** |
| **the new key deploys `pos!("bond", …, 100)`** | ✅ value **`(true)`** |
| `getBonds` afterwards | ✅ grew 2 → 3 (A 1000, newcomer 100, B 100) |
| `getActiveValidators` afterwards | ✅ 3 validators |
| `pos!("withdraw", …)` | ✅ value `(true)` — deactivates at once, stake escrowed |
| `rnode deploy` with no `--valid-after-block-number` | ✅ `processedWithSuccess` |

**A caution learned the hard way.** Bonding a key that has no running node still counts against
finality: when the newcomer bonded 100, A's share fell from 75% to 60% of the pool, and with no
`--autopropose` A is the only proposer, so blocks kept arriving but nothing was finalised any more
(`Finalized fringe is not available`). `withdraw` is not an instant escape either — the stake stays in
the pool until the quarantine deadline. Hence A's 1000.

## Known issues

**K1 — `rnode deploy` used to drop deploys in silence. ✅ FIXED 2026-09-21 and deployed to both nodes.**

Without the flag the CLI sent `valid_after_block_number = -1`
(`node/src/runtime/node_main.rs`: `valid_after_block_number.unwrap_or(-1)`), and a deploy is expired
once `height - valid_after_block_number > DEPLOY_LIFESPAN` (50) — enforced when the pool is swept
(`casper/src/dag.rs::expire_deploys`) and again by the proposer
(`casper/src/blocks/proposer/proposer.rs`). On any chain taller than ~49 blocks every unflagged CLI
deploy was therefore *deleted from the pool*: the node answered `Response: Success!` with a DeployId
and the deploy was then silently never proposed, which is why the proposer logged
`No pooled deploys; injecting dummy deploy for block #NNN` indefinitely. The node's own faucet
documents the rule (`node/src/api/faucet.rs`): *"must be the current chain height (not `-1`)"*.

Measured on the testnet, same term and key:

| deploy | status |
|---|---|
| no flag, before the fix (height 904) | `notProcessed / Unknown` |
| `--valid-after-block-number 904`, before the fix | `processedWithSuccess` |
| **no flag, after the fix** (height ~1060) | **`processedWithSuccess`** |

rhobot hid it: at height 8, `-1 < 8 - 50` is false, so deploys there always passed. The dummy-deploy
injector was never involved — it only fires when the pool really is empty, and it was enabled
throughout.

The fix (`fix/deploy-expiry-negative`, commit `756f1727d`) makes a negative anchor mean "not
specified" and resolves it from the node's own status, which already carries `latest_block_number` —
the same thing the faucet, the browser client, `gateway::current_height` and
`txn_coordinator::run_phase_at` do. The fix is merged to `dev` as
[#58](https://github.com/rchain-community/rchain-rust/pull/58), and all three nodes run a binary that
includes it (`d7f5000b…`, which also carries the upstream registry-lookup fix), so `rnode deploy` works
with no extra flags. Rollbacks are kept in place as `/usr/local/bin/rnode.old-<sha>`.
**A binary built before that commit still needs `--valid-after-block-number <height>`.**

**K2 — an earlier diagnosis in this document was wrong; corrected.** It blamed the dummy-deploy
injector and claimed that removing it left A's HTTP API unresponsive. K1 shows the injector has
nothing to do with deploy inclusion, and the unresponsive-API observation is better explained by
start-up latency: a healthy restart took ~55s before `/api/status` answered, and the check that
appeared to hang was made ~25s in. The injector stays on because it is what keeps blocks flowing for
joiners. **Do not treat the injector as a suspect for deploy problems.**

**K3 — transfers credit a spendable vault; an earlier claim here was wrong and is retracted.**
Phlo is charged against the deployer's vault (`native_state.rs::pre_charge`, which derives the address
as `RevAddress::from_public_key(deployer)` and returns `preCharge: insufficient funds (… < …)` as a
*value* — which is exactly what `processedWithError` on a trivial deploy looks like). An earlier
revision of this document concluded from such errors that only `wallets.txt`-funded keys could ever
spend. That was an artifact of a chain that was already OOM-thrashing (K7); on a healthy chain the
same experiment gives the opposite answer:

| step | measured |
|---|---|
| a brand-new key's balance | `0` |
| transfer 1e11 to it | balance `100000000000` |
| it deploys `return!(1)` | **value `"1"`** — a transfer-funded key deploys fine |

So funding a new key works. The requirement that does bite is that the **trusted** key must be funded,
because it pays for its own `trust` deploy — and the genesis bond keys are not in `wallets.txt`. Hence
`--pos-multi-sig-public-keys <dave>` (K6).

**K4 — read deploy output from the term, not from `deploy-status`.** `stdout!(…)` from a deploy does
not reach the journal, and `deploy-status` for a failed deploy answers
`"deploy error message not available in cache or deploy executed on another node"`. The way in is the
registry result-slot pattern the browser client uses: `scripts/qos-cli/rholang-client.mjs`'s
`deployTerm` wraps the term so that its return value is stored and handed back. That is how the
[verified path](#status-of-the-verified-path) was measured.

An earlier revision warned that this read-back "lags by about one deploy". That was wrong: the lag was
dev's registry-lookup divergence (C18 — the native handler wrapped its reply in `(uri, value)` while
the genesis `Registry.rho` forwards it unwrapped, so a client's `for (X <- ch) { X!(…) }` silently did
nothing, with no error and no result). It is fixed in the binary these nodes run (`d7f5000b…`), and
with it deploy result values are readable — which is what unblocked the whole diagnosis.

**K5 — disk and memory growth.** Disk now grows only with real usage (~6.6 KB/block) since the injector
is gone. Memory is the constraint that matters, and it grows with the length of the chain rather than
with activity — see K7.

**K6 — live validator admission works. Two earlier claims here were wrong; both are retracted.**

The first said the genesis-seeded trusted set reads as empty at runtime; the second said no key on
this chain could be both trusted and able to deploy. Both came from experiments run on a chain that
was already OOM-thrashing (K7), where every deploy failed on phlo for reasons unrelated to trust.

On the rebuilt chain the whole path is verified — see
[Status of the verified path](#status-of-the-verified-path):

- a trusted key's `pos!("trust", …)` returns **`(true)`**, so `trusted` *is* seeded and readable at
  deploy time; it contains dave, admitted by `--pos-multi-sig-public-keys`;
- the newly trusted key's `pos!("bond", …, 100)` returns **`(true)`**, and both the bond pool and the
  active validator set grow;
- an untrusted key's `trust` still answers
  `(false, "Only a trusted stakeholder can admit validators.")` — correct.

The one real requirement: **the trusted key must be able to pay phlo**, so it has to be funded. The
genesis bond keys are not in `wallets.txt`, so the trusted set is seeded with dave instead, via
`--pos-multi-sig-public-keys <hex> --pos-multi-sig-quorum 1` — on every node, so a joiner's own view
of the genesis PoS spec matches the chain it is joining.

**K7 — start-up replay is the expensive part of a node's life, and it is invisible while it runs.
This is the most important operational constraint here. Now tracked upstream as
[rchain-rust#60](https://github.com/rchain-community/rchain-rust/issues/60).**

Measured on the same 1142-block state, on a 4 GB host so the replay could actually finish:

| configuration | start-up RSS | API reachable after |
|---|---|---|
| fresh chain (≤6 blocks) | 18–20 MB | **15 s** |
| replay, read-only | 57 → 284 MB (oscillating) | **225 s** |
| replay, `-s --dev-mode --propose-on-deploy` | 52 → 285 MB (oscillating) | **210 s** |
| an isolated chain *producing* blocks (`--autopropose` + injector) | 20 → 23 MB while going 10 → 141 blocks | — |

So the cost is all in start-up — **roughly 0.25 MB of RSS and ~0.2 s per existing block** — while
producing blocks is nearly free (~0.02 MB/block). An earlier revision of this section said "about 1 MB
per block"; that was arithmetic from the OOM below, and the measurement does not support it.

What actually killed the previous chain: on a 957 MB host that was also running nginx, do-agent and
certbot, rnode was OOM-killed while replaying, at **738 MB `anon-rss`** — higher than the ~285 MB the
same state needs in isolation, and the extra several hundred MB is *not yet explained* (issue #60 lists
the candidates: a bonded validator identity, the running injector, a peer that is itself replaying,
concurrent LFS state transfer). After the kill, every restart replayed the same DAG and died again, in a
loop: the API never answered (`api-unreachable no-blocks`) while `systemctl is-active` still reported
`active`. That, not the injector, is the real explanation of the "removing the injector left the API
unresponsive" observation in K2.

What was done about it here, and what it means for operators:

- the rebuilt chain runs **without `--autopropose` and without `--deployer-private-key`**, so blocks
  arrive only when deploys do and restart cost tracks real usage instead of wall-clock time;
- a fresh chain starts in **15 s at 18–20 MB**, where the 1142-block chain could not restart usefully;
- the health check no longer fails on a missing finalised fringe — an idle chain has none, and joiners
  restore from the approved genesis fringe instead;
- **host sizing:** 1 GB is fine for a few hundred blocks, but budget ≥2 GB for ~1k blocks and ≥4 GB to
  be comfortable — and expect ~30 s per 150 blocks of unavailability after every restart, with no
  readiness signal until the API appears;
- if a long chain does fail to come up, check whether the PID's RSS is *growing* before assuming a hang:
  replay is silent, and restarting faster does not help.

## Housekeeping

- Snapshots/rollback: unit files are backed up in place (`rnode.service.bak-<epoch>`), node binaries as
  `/usr/local/bin/rnode.old-<sha>`, and each rebuild left the previous data dir as
  `/var/lib/rnode.bak-<timestamp>`. The genesis files are the source of truth and are tiny; those old
  data dirs (4.5 MB each) can be deleted once the new chain is confirmed.
- Firewall: `ufw` allows `22`, `40400`, `40401`, `40403`, `40404`, `40405`, plus `80`/`443` on A.
  Nothing else — the old rhobot box's 36-rule ruleset was pruned to what actually has listeners.
- Certificates renew via `certbot.timer` on A (nginx authenticator), first expiry 2026-12-20.
- To move the testnet to another host: copy `bonds.txt`, `wallets.txt`, the validator key and the
  static musl `rnode` binary. The binary is self-contained (no Docker, no runtime deps).

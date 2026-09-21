# Testnet — `testnet.rhobot.net`

A small public RChain testnet run on [rchain-rust](../) for the rholang playground, the room
agents and experiments. Two bonded validators on two hosts, dev-mode block production, funded
dev wallets.

> **Status: READS WORK, WRITES DO NOT (yet).** `/api/status`, `/api/explore-deploy` (eval),
> `getBonds`, `getActiveValidators` and `/health` all work. Deploys are *accepted* but **do not
> land in blocks** on the current configuration — see [Known issues](#known-issues). Treat this
> testnet as read-only until K1 is fixed. It is not production, holds no value, and its chain
> can be rebuilt (and therefore reset) at any time.

---

# Part 1 — For users

## What it is

| | |
|---|---|
| Chain | `testnet` network id, shard `/root`, genesis `c14849a4…573a` |
| Validators | node A (stake 300) + node B (stake 100), both dev-mode |
| Hosts | A `164.90.140.144` (private `10.108.0.3`), B `104.131.176.164` (private `10.108.0.4`) |
| Cost | 2 × DigitalOcean `s-1vcpu-1gb`, **$12/mo** |
| Endpoint | **https://testnet.rhobot.net** (nginx → node A's HTTP API) |

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
| Reads of chain state (`getBonds`, `getActiveValidators`, balances) | ✅ works |
| `GET /api/status` | ✅ works |
| `/health` monitoring snapshot | ✅ works |
| **Deploys** (transfers, contracts, bonding) | ❌ **accepted but never included** — K1 |
| Facet / faucet transfers | ❌ same cause — the transfer deploy does not land |

## Monitoring

`https://testnet.rhobot.net/health` is refreshed every 60 seconds by each node and answers with
that node's snapshot (node A's, since nginx fronts A):

```json
{ "host": "testnet-a", "ok": true, "rnode_unit": "active", "api_reachable": true,
  "blocks": 866, "blocks_since_last_tick": 0, "peers": 1, "nodes": 1,
  "finalized_fringe": true, "autopropose": true,
  "mem_available_mb": 367, "disk_free_mb": 22665 }
```

`ok: false` means the unit is down, the API is unreachable, the height is zero, or — the failure
that silently breaks joining — **there is no finalised fringe**. DigitalOcean's dashboard also
graphs CPU/RAM/disk for both hosts (`do-agent`).

## Limits to expect

- **Dev-mode.** The chain is kept moving by an injected dummy deploy; heights advance whether or
  not anyone is doing anything.
- **A rebuild resets everything.** Changing `bonds.txt`/`wallets.txt` means a new genesis and a
  new chain.
- ~140 MB/day of growth at the current rate (a block every ~2–4s). Watch `disk_free_mb`.
- No SLA, no backups of chain state beyond the genesis files.

---

# Part 2 — For maintainers

## Topology

```
testnet.rhobot.net ──► node A 164.90.140.144 (10.108.0.3)   genesis master, stake 300
                        └─ nginx + Let's Encrypt (cert to 2026-12-20), /health from a timer
                        └─ rnode: -s --dev-mode --autopropose --deployer-private-key …
                       node B 104.131.176.164 (10.108.0.4)   joining validator, stake 100
                        └─ rnode: --dev-mode --propose-on-deploy  (NO --autopropose)
```

Both live in the `default-nyc3` VPC, the same one as rhobot-2, so they can also talk over
private addresses (`10.108.0.0/20`).

**Why the stake is 300/100 and not 100/100.** Finality needs >⅔ of the stake. With two equal
validators a lone master can never reach it, so it cannot finalise — and because joiners sync
through the **finalised fringe**, a joining node would then wait forever for a fringe that never
appears. That is exactly the deadlock seen on rhobot (an observer stuck at block 0 with
`Finalized fringe is not available`). At 300/100, A alone is 75% and finalises immediately, and
B is still a real bonded validator once it joins.

## Genesis

Built once with `scripts/localnet/keys.mjs`; the exact files are on each node:

```
/var/lib/rnode/genesis/bonds.txt    2 lines: <65-byte pubkey> <stake>
/var/lib/rnode/genesis/wallets.txt  6 funded REV addresses (the dev keys)
/etc/rnode/validator.key            that node's validator key (0600 rnode:rnode)
/etc/rnode/deployer.env             DEPLOYER_PRIVATE_KEY=… (dev-mode injector)
```

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
rnode --profile docker run -s --dev-mode --autopropose --no-upnp --host <ip> \
  --data-dir /var/lib/rnode \
  --bonds-file /var/lib/rnode/genesis/bonds.txt \
  --wallets-file /var/lib/rnode/genesis/wallets.txt \
  --validator-private-key-path /etc/rnode/validator.key \
  --deployer-private-key ${DEPLOYER_PRIVATE_KEY}
# a joining validator: same flags minus -s, plus --bootstrap, and its own validator key
```

There is **no `--no-autopropose` flag** — you omit `--autopropose`. (`tools/devnet.sh` accepts
`--no-autopropose` because that is *its* CLI; it only omits the node flag.) Passing it makes the
node exit 1 in a restart loop.

## Adding a node (observer)

An observer is any node without a bonded key. It replicates the chain and can be started
anywhere:

```bash
rnode --profile docker run --host <its-ip> --data-dir /var/lib/rnode \
  --bootstrap rnode://b48cd51989b159658824c6d0337a576ba241dd63@164.90.140.144?protocol=40400&discovery=40404
```

Success looks like this in the log — note the LFS step, which is what fails when no fringe
exists:

```
INFO [casper.engine.NodeSyncing] Adding #0 c14849a4…573a.
INFO [casper.engine.NodeSyncing] Blocks for approved state added to DAG.
INFO [casper.engine.NodeSyncing] LFS state is successfully restored.
INFO [casper.engine.NodeLaunch] Making a transition to Running state.
```

## Onboarding an observer into the validator pool

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

Two funding prerequisites that are easy to miss:

- the **trusting key must hold REV**, because it pays phlo for the `trust` deploy from its own
  vault — genesis validator keys are *not* funded in `wallets.txt` (K3);
- the **newcomer must hold REV ≥ stake**, because the bond is deducted from its vault.

A plain transfer fixes both: `revVault!("transfer", *deployerId, "<its REV address>", <amount>, *ret)`
(reply is `Nil` on success, an error string on failure). To derive a key's vault address:
`node -e "import('./keys.mjs').then(m=>console.log(m.revAddressOf('<priv>')))"`.

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
// → {"expr":[{"ExprMap":[["0410b8c5…0c3c73",{"ExprInt":300}],["04675f16…514404",{"ExprInt":100}]]}]}

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

Deploy them the way `tools/devnet.sh` does:

```bash
rnode --profile docker deploy --phlo-limit 90000 --phlo-price 1 --shard-id /root \
  --private-key <hex> term.rho
rnode --profile docker deploy-status --deploy-signature <deployId>
```

`--shard-id /root` is required; without it the node answers
`Deploy shardId '' is not a member of this node's shards: [/root]`.

### Status: not yet demonstrated end to end

The read paths above are **verified on the live testnet**. The write path is **code-verified
only**: on 2026-09-21 the `trust` and `bond` deploys were accepted
(`Response: Success!`, DeployIds issued) but `deploy-status` reported
`"notProcessed": {"status": "Unknown"}` and `getBonds` was unchanged — because *no* deploy lands
on this configuration (K1 below). **Fix K1 first, then re-run the sequence above** and expect
`getBonds` to gain the newcomer's key.

## Known issues

**K1 — deploys are accepted but never included (blocks writes).** With the dev-mode dummy-deploy
injector enabled, every block logs `No pooled deploys; injecting dummy deploy for block #NNN` and
a freshly submitted deploy reports `notProcessed / Unknown`. Isolation: rhobot runs dev-mode
*without* `--deployer-private-key` and the same deploy reports `processedWithSuccess`. Removing
the injector from A changed the status to `Pooled` (i.e. the deploy then reached the pool).
Consequence: no transfers, contracts or bonding execute on the testnet; `eval` is unaffected.

**K2 — removing the injector left A's HTTP API unresponsive.** With the injector removed the
node was up, listening on 40403/40405, gRPC 40401 accepted deploys — but HTTP requests hung and
the health timer reported `api-unreachable`. Caveat: a healthy restart also needed ~55s before
the API answered, so a slow start is a possible confound rather than a genuine hang. The injector
was restored so the node stays usable; **this needs a proper investigation in rchain-rust before
the testnet can be relied on for writes.**

**K3 — genesis validator keys are unfunded.** `wallets.txt` funds the dev keys, not the bonded
validator keys, so a genesis validator cannot pay phlo to deploy `trust`. Fund one first with a
transfer to its vault address (see the two admission routes).

**K4 — deploy stdout is not logged.** `stdout!(…)` from a deploy does not appear in the journal,
so a failed `bond`/`trust` cannot be diagnosed from logs; the return value is only reachable
through the registry result-slot pattern (`insertSigned` with a nonce) that the browser client
uses.

**K5 — disk growth.** With the injector on, the chain grows ~140 MB/day (a block every ~2–4s,
~6.6 KB/block). `/health` reports `disk_free_mb`; 25 GB gives months of headroom, but a busy
testnet will need a plan.

## Housekeeping

- Snapshots/rollback: the unit files are backed up in place (`rnode.service.bak-<epoch>`);
  genesis files are the source of truth and are tiny.
- Firewall: `ufw` allows `22`, `40400`, `40401`, `40403`, `40404`, `40405`, plus `80`/`443` on A.
  Nothing else — the old rhobot box's 36-rule ruleset was pruned to what actually has listeners.
- Certificates renew via `certbot.timer` on A (nginx authenticator), first expiry 2026-12-20.
- To move the testnet to another host: copy `bonds.txt`, `wallets.txt`, the validator key and the
  static musl `rnode` binary. The binary is self-contained (no Docker, no runtime deps).

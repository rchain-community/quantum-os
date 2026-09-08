# A local node to develop `/rholang` against

```bash
bash run-node.sh --fresh     # first time only: build a new chain from bonds.txt + wallet.txt
bash run-node.sh             # every other time — reuses the existing chain
```

**`--fresh` builds a new genesis. Only pass it when you mean to.** Swapping
`bin/rnode` is usually a *data-compatibility test* — you want the new binary to
read the chain the old one wrote, so you start it **without** `--fresh` and
watch for read errors / stalled block production. `--fresh` moves the old data
dir to a timestamped `.bak-` (keeping the last 3) rather than deleting it, so a
genesis you didn't intend is recoverable — but the running chain still resets.

The node binary is `bin/rnode` at the repo root, committed so that a checkout of
quantum-os alone brings a chain up — no rchain-rust checkout, no PATH symlink.
To try a candidate build against a copy of the current chain first:

```bash
cp -r ~/.rnode-local ~/.rnode-local.candidate
RNODE=~/rnode QOS_RNODE_DATA=~/.rnode-local.candidate bash run-node.sh   # no --fresh
```

`run-node.sh` prints which binary it is running, and refuses to start if the path
is not executable rather than silently falling back to a different node.

Then, in the browser:

```
/rholang rnode http://127.0.0.1:40403
/rholang status
/rholang eval                ← opens the editor; Ctrl+Enter runs it
```

Ports: **40401** deploy gRPC · **40402** eval/propose gRPC · **40403** HTTP (what
the browser uses) · **40405** admin HTTP.

## The files

| file | what it is |
|---|---|
| `pk.txt` | secp256k1 secret keys, `name=hex`. **Throwaway, local only.** |
| `wallet.txt` | `<REV address>,<balance>` for every key in `pk.txt` — the genesis wallets file |
| `bonds.txt` | the validator's public key and stake |
| `keys.mjs` | derives REV addresses; regenerates `wallet.txt` |
| `run-node.sh` | the rnode invocation, with why each flag is there |
| `../../bin/rnode` | the node binary itself; `RNODE=` overrides it |

The keys are in the repository on purpose: a local devnet needs a funded key, and
a key nobody can read funds nobody. The validator key is rchain-rust's own
published devnet key; the deployer key was generated here. Both are worthless on
any real network, and using either anywhere with value would hand it away.

```bash
node keys.mjs                              # addresses for the keys in pk.txt
node keys.mjs --generate                   # a fresh key
node keys.mjs --wallet 1000000000000 > wallet.txt
```

A REV address is derived the way rnode derives it, so `wallet.txt` funds the
address a deploy is actually charged to:

```
eth     = last 20 bytes of keccak256(public key without its 0x04 prefix)
payload = 00000000 ++ keccak256(eth)
address = base58(payload ++ first 4 bytes of blake2b256(payload))
```

Checked against rchain-rust's own devnet key, which derives to the address its
`tools/devnet.sh` publishes.

## What works

Verified against rchain-rust `dev` at `f3f4759e9`.

**`/rholang eval` works**, including the powerbox. It runs the program in a
read-only sandbox over finalized state and hands back whatever reached `return`,
and the system processes answer there:

```
new return, zfa(`rho:qucalc:zfa`) in { zfa!([0,1], *return) }
  -> (true, -1)
```

One flag earns its place here: rnode refuses exploratory deploy unless it is a
read-only observer or in `--dev-mode`, which is why `run-node.sh` sets it.

**`/rholang deploy` executes and is charged.** The node verifies a secp256k1
signature over blake2b256 of the protobuf encoding of `DeployDataProto`, answers
`Success!`, and the deploy lands in a block having run:

```
errored=False  cost=1486
```

A deploy's `return` is unforgeable and the deploy is over by the time anyone
asks, so the wrapper writes what it answered to the deployer's own registry slot
— the uri derived from the key, which only that key can write to. Read it back
by resolving that uri, which is what `readResult` in
`packages/browser/src/rholang.ts` does:

```
zfa!([2,3,0,1])    -> (true, 1)
grant!([2,3,0,1])  -> rho:id:wyncu1hpry1gwfq6hoc1kwezkpycwddk51monimmknu4c6azhi9o
```

Restarting on a chain that already holds an executed deploy is fine — drop the
`--fresh` and it reconnects to its own state, and further deploys still reach the
powerbox.

**Note the API wants JSON.** `POST /api/explore-deploy` rejects a `text/plain`
body with *"Expected request with `Content-Type: application/json`"*; the term
goes up as a JSON string. `rholang.ts` already does this.

## What is known about rnode

Checked against `dev` at `0a2141be1`, the build `bin/rnode` ships.

**`match` selects the branch it should.** First written branch wins, a `_`
wildcard is reached when nothing before it matches, and a later branch does not
steal an earlier one:

```
match 1  { 1 => { return!("first") }  _ => { return!("wildcard") } }   ->  "first"
match 99 { 1 => { return!("one") }    _ => { return!("wildcard") } }   ->  "wildcard"
match 2  { 1 => {…} 2 => { return!("two") } 3 => {…} }                 ->  "two"
```

**A runaway term returns an error and leaves rnode running.** Exploratory deploy
carries a reduction step budget:

```
"[ReduceError(\"reduction step budget exceeded (10000 steps)\")]"
```

The ceiling does not reach ordinary work — a terminating recursion returns its
answer at depth 2560.

Two things to know when writing contracts here:

**[#19](https://github.com/rchain-community/rchain-rust/issues/19) — a
one-binder persistent receive inside a nested `new` does not terminate.** It
re-fires until the budget stops it. Give every `contract` at least two
parameters; where a verb genuinely takes only a return channel, an ignored first
parameter restores it:

```rholang
contract c(_, ret) = { ret!(9) }
```

**The budget error is a bare JSON string**, where a successful run returns a
`{expr, block}` object. A client written for the success shape will render a
runaway as an empty result rather than as an error, which is a slow way to find
one.

## Checking the macros still work

```bash
node macro-check.mjs            # --node <url>, --verbose
```

Runs every macro expansion on this node. A failure gives the macro, the line it
died on, and what rnode answered.

Not in CI: it needs a running node.

## Ordering of returned values

Several sends to `return` all come back, but **not in the order they were
written**, and the two read paths differ. Under `eval` the values arrive in
reverse source order (deterministic across runs here); read back from a public
name after a deploy, the order was neither source nor reverse. Rholang's `|` is
parallel composition with no ordering semantics, so none of this is a guarantee.

If order matters, put it in the program — one list, `return!([a, b, c])`;
index-tagged tuples the caller sorts; or an accumulator whose single token
serializes the appends:

```rholang
acc!("") |
contract log(@msg, ack) = { for (@s <- acc) { acc!(s ++ msg) | ack!(Nil) } }
```

// captp.test.mjs — capability transport: bridge identity + derived room (Phase 1).
//
// Covers `captp.ts`: shard-ref normalization, the order-independent pair key,
// and — the load-bearing bit — that `deriveBridgeRoom` is deterministic,
// order-independent, owner-bound, and always yields a token that passes the
// kernel's `validateCapability` (count balance ∧ Pauli closure).
//
//   node packages/browser/test/captp.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "captp.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
  external: ["@quantum-os/zfa-core"], // WASM — pure-TS fallback on this path
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

// zfa.ts, bundled in, for the independent validity check.
const zfaBundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "zfa.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
  external: ["@quantum-os/zfa-core"],
});
const { validateCapability } = await import(
  "data:text/javascript;base64," + Buffer.from(zfaBundle.outputFiles[0].text).toString("base64"));

const {
  ownerId, normalizeShardRef, bridgePairKey, bridgeVaultHandle,
  deriveBridgeRoom, makeBridge, bridgeSpecIsConsistent,
  newTransferId, transferNonce, captpConservationCheck, captpAdvance,
  captpOfferFromWire, burnReceiptFromWire, mintReceiptFromWire, captpReceiptFromWire,
  burnReceiptToTuple, burnReceiptFromTuple,
} = mod;

let failed = 0;
const ok = (label, cond) => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}`); }
};

const alice = { kind: "person", anchor: "a".repeat(64) };
const bob = { kind: "person", anchor: "b".repeat(64) };
const ops = { kind: "group", groupId: "cap:group:24602460246024602460246024602460" };
const A = "http://127.0.0.1:40403";
const B = "http://127.0.0.1:40404";

// --- ownerId ---------------------------------------------------------------
{
  ok("ownerId person", ownerId(alice) === `person:${"a".repeat(64)}`);
  ok("ownerId group", ownerId(ops) === `group:${ops.groupId}`);
  ok("person and group ids never collide", ownerId(alice) !== ownerId(ops));
}

// --- normalizeShardRef ----------------------------------------------------
{
  ok("bare host:port gets a scheme", normalizeShardRef("127.0.0.1:40403") === "http://127.0.0.1:40403");
  ok("trailing slash dropped", normalizeShardRef("http://x.test:9/") === "http://x.test:9");
  ok("host lowercased", normalizeShardRef("http://Node.Example:5") === "http://node.example:5");
  ok("default http port dropped", normalizeShardRef("http://x.test:80") === "http://x.test");
  ok("https default port dropped", normalizeShardRef("https://x.test:443") === "https://x.test");
  ok("garbage → null", normalizeShardRef("   ") === null);
}

// --- bridgePairKey / vault handle ---------------------------------------
{
  ok("pair key is order-independent", bridgePairKey(A, B) === bridgePairKey(B, A));
  ok("pair key is 16 hex", /^[0-9a-f]{16}$/.test(bridgePairKey(A, B)));
  ok("different pairs differ", bridgePairKey(A, B) !== bridgePairKey(A, "http://127.0.0.1:40405"));
  ok("normalization feeds the key", bridgePairKey("127.0.0.1:40403", B) === bridgePairKey(A, B));
  ok("vault handle namespaced", bridgeVaultHandle(A, B) === `captp:${bridgePairKey(A, B)}`);
}

// --- deriveBridgeRoom ---------------------------------------------------
{
  const r1 = deriveBridgeRoom(alice, A, B);
  ok("derived room is a cap:room token", /^cap:room:[0-7]+$/.test(r1));
  ok("derived room passes validateCapability (this module)", validateCapability(r1));
  ok("derived room is 32 twists", r1.split(":")[2].length === 32);
  ok("deterministic — same inputs, same room", deriveBridgeRoom(alice, A, B) === r1);
  ok("order-independent in the shard pair", deriveBridgeRoom(alice, B, A) === r1);
  ok("normalization applies", deriveBridgeRoom(alice, "127.0.0.1:40403", B) === r1);

  ok("owner-bound — a different person, a different room", deriveBridgeRoom(bob, A, B) !== r1);
  ok("owner-bound — a group, a different room", deriveBridgeRoom(ops, A, B) !== r1);
  ok("pair-bound — a different shard, a different room",
     deriveBridgeRoom(alice, A, "http://127.0.0.1:40405") !== r1);

  let threw = false;
  try { deriveBridgeRoom(alice, A, A); } catch { threw = true; }
  ok("two of the same shard throws", threw);
}

// --- makeBridge / consistency ----------------------------------------
{
  const spec = makeBridge("127.0.0.1:40403", B, "root", "shard-b", 111);
  ok("spec normalizes shard refs", spec.shardA === A && spec.shardB === B);
  ok("spec carries the ids", spec.idA === "root" && spec.idB === "shard-b");
  ok("spec carries the timestamp", spec.at === 111);
  ok("ids default when blank", makeBridge(A, B, "", "").idA === "shard-a");
  ok("fresh spec is consistent", bridgeSpecIsConsistent(spec));
  ok("same-node bridge is rejected", (() => { try { makeBridge(A, A, "x", "y"); return false; } catch { return true; } })());
  ok("a spec with equal urls is inconsistent", !bridgeSpecIsConsistent({ ...spec, shardB: A }));
  ok("a spec missing an id is inconsistent", !bridgeSpecIsConsistent({ ...spec, idB: "" }));
}

// --- transfer id + deterministic nonce --------------------------------
{
  const a = newTransferId(), b = newTransferId();
  ok("transfer id is 16 hex", /^[0-9a-f]{16}$/.test(a));
  ok("transfer ids differ", a !== b);
  ok("nonce is a pure function of the id", transferNonce(a) === transferNonce(a) && transferNonce(a) === `captp-${a}`);
  ok("nonce accepts an offer or an id", transferNonce({ id: a }) === transferNonce(a));
}

// --- conservation -----------------------------------------------------
{
  const burn = { tag: "captp-burn", srcShard: "root", subject: "1111x", amount: "30", nonce: "captp-1", destAddr: "1111bob" };
  const mint = { tag: "captp-mint", dstShard: "shard-b", srcShard: "root", destAddr: "1111bob", amount: "30", nonce: "captp-1" };
  ok("matching burn/mint conserve", captpConservationCheck(burn, mint));
  ok("amount mismatch fails", !captpConservationCheck(burn, { ...mint, amount: "31" }));
  ok("nonce mismatch fails", !captpConservationCheck(burn, { ...mint, nonce: "captp-2" }));
  ok("dest mismatch fails", !captpConservationCheck(burn, { ...mint, destAddr: "1111eve" }));
  ok("non-numeric amount fails", !captpConservationCheck({ ...burn, amount: "3e1" }, { ...mint, amount: "3e1" }));
}

// --- state machine ---------------------------------------------------
{
  const offer = { id: "abc", pair: bridgePairKey(A, B), srcShard: A, dstShard: B, what: "value", amount: "30", destAddr: "1111bob", by: "p1", at: 1, expiresAt: 9 };
  const burn = { tag: "captp-burn", srcShard: "root", subject: "1111x", amount: "30", nonce: transferNonce("abc"), destAddr: "1111bob" };
  const mint = { tag: "captp-mint", dstShard: "shard-b", srcShard: "root", destAddr: "1111bob", amount: "30", nonce: transferNonce("abc") };
  let t = { offer, status: "offered", updatedAt: 0 };

  const t0 = t;
  t = captpAdvance(t, { k: "mint", mint }, 1);
  ok("mint before lock is a no-op", t === t0);

  t = captpAdvance(t, { k: "lock", burn }, 2);
  ok("lock advances offered → locked", t.status === "locked" && t.burn === burn);

  const tLocked = t;
  t = captpAdvance(t, { k: "lock", burn }, 3);
  ok("re-lock with the same burn is idempotent", t.status === "locked");
  ok("idempotent re-lock still updates the clock", t.updatedAt === 3);
  t = captpAdvance(tLocked, { k: "mint", mint: { ...mint, amount: "31" } }, 4);
  ok("mint that breaks conservation is a no-op", t === tLocked);

  t = captpAdvance(tLocked, { k: "mint", mint }, 5);
  ok("mint advances locked → minted", t.status === "minted" && t.mint === mint);

  const receipt = { id: "abc", burn, mint, at: 6 };
  const tMinted = t;
  t = captpAdvance(t, { k: "receipt", receipt }, 6);
  ok("receipt advances minted → receipted", t.status === "receipted" && t.receipt === receipt);

  const done = t;
  t = captpAdvance(t, { k: "abort", reason: "too late" }, 7);
  ok("abort after receipted is a no-op", t === done);

  // abort from offered
  let u = captpAdvance({ offer, status: "offered", updatedAt: 0 }, { k: "abort", reason: "changed my mind" }, 1);
  ok("abort from offered → aborted", u.status === "aborted" && u.abortReason === "changed my mind");
  ok("lock after abort is a no-op", captpAdvance(u, { k: "lock", burn }, 2) === u);
}

// --- wire validators ------------------------------------------------
{
  const good = {
    id: "d34db33f", pair: bridgePairKey(A, B), srcShard: "127.0.0.1:40403", dstShard: B,
    what: "value", amount: "30", destAddr: "1111bob", by: "peer1", at: 1, expiresAt: 2,
  };
  const o = captpOfferFromWire(good);
  ok("a good offer parses", !!o && o.srcShard === A && o.amount === "30");
  ok("offer normalizes shard refs", o.srcShard === A);
  ok("wrong pair key is rejected", captpOfferFromWire({ ...good, pair: "0000000000000000" }) === null);
  ok("same src and dst is rejected", captpOfferFromWire({ ...good, dstShard: "127.0.0.1:40403" }) === null);
  ok("value offer needs a numeric amount", captpOfferFromWire({ ...good, amount: "lots" }) === null);
  ok("cap offer needs a cap", captpOfferFromWire({ ...good, what: "cap", amount: undefined }) === null);
  ok("missing destAddr is rejected", captpOfferFromWire({ ...good, destAddr: "" }) === null);
  ok("junk is rejected", captpOfferFromWire(null) === null && captpOfferFromWire("x") === null);

  const burn = { tag: "captp-burn", srcShard: "root", subject: "1111x", amount: "30", nonce: "captp-d34db33f", destAddr: "1111bob" };
  const mint = { tag: "captp-mint", dstShard: "shard-b", srcShard: "root", destAddr: "1111bob", amount: "30", nonce: "captp-d34db33f" };
  ok("burn receipt parses", !!burnReceiptFromWire(burn));
  ok("burn receipt with bad tag rejected", burnReceiptFromWire({ ...burn, tag: "x" }) === null);
  ok("mint receipt parses", !!mintReceiptFromWire(mint));
  ok("captp receipt parses and conserves", !!captpReceiptFromWire({ id: "d34db33f", burn, mint, at: 5 }));
  ok("captp receipt rejects non-conserving pair", captpReceiptFromWire({ id: "x", burn, mint: { ...mint, amount: "1" }, at: 5 }) === null);
}

// --- rholang tuple round-trip -------------------------------------
{
  const burn = { tag: "captp-burn", srcShard: "root", subject: "1111x", amount: "30", nonce: "captp-abc", destAddr: "1111bob" };
  const tuple = burnReceiptToTuple(burn);
  ok("tuple text is the rholang shape", tuple === `("captp-burn", "root", "1111x", 30, "captp-abc", "1111bob")`);
  const back = burnReceiptFromTuple(tuple);
  ok("tuple round-trips", !!back && back.srcShard === "root" && back.subject === "1111x" && back.amount === "30" && back.nonce === "captp-abc" && back.destAddr === "1111bob");
  ok("an error list is not a burn receipt", burnReceiptFromTuple('["dup nonce", "captp-abc"]') === null);
  ok("whitespace is tolerated", !!burnReceiptFromTuple(`  ${tuple}  `));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);

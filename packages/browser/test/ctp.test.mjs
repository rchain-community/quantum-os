// ctp.test.mjs — capability transport: bridge identity + derived room (Phase 1).
//
// Covers `ctp.ts`: shard-ref normalization, the order-independent pair key,
// and — the load-bearing bit — that `deriveBridgeRoom` is deterministic,
// order-independent, owner-bound, and always yields a token that passes the
// kernel's `validateCapability` (count balance ∧ Pauli closure).
//
//   node packages/browser/test/ctp.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "ctp.ts")],
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
  deriveBridgeRoom, makeBridgeSpec, bridgeSpecIsConsistent,
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
  ok("vault handle namespaced", bridgeVaultHandle(A, B) === `ctp:${bridgePairKey(A, B)}`);
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

// --- makeBridgeSpec / consistency --------------------------------------
{
  const spec = makeBridgeSpec(alice, "127.0.0.1:40403", B, 111);
  ok("spec normalizes shard refs", spec.shardA === A && spec.shardB === B);
  ok("spec roomCap matches deriveBridgeRoom", spec.roomCap === deriveBridgeRoom(alice, A, B));
  ok("spec carries the timestamp", spec.at === 111);
  ok("fresh spec is consistent", bridgeSpecIsConsistent(spec));
  ok("tampered roomCap is caught", !bridgeSpecIsConsistent({ ...spec, roomCap: "cap:room:2460" }));
  ok("tampered owner is caught", !bridgeSpecIsConsistent({ ...spec, owner: bob }));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);

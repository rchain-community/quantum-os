// rholang-client.mjs — headless rnode deploy-signing client for a Node agent.
//
// A hand port of the deploy-signing path in packages/browser/src/rholang.ts —
// same protobuf encoding, same secp256k1 signing, same REV-address derivation
// — with the browser-only bits (localStorage config, per-node result-slot
// bookkeeping) swapped for plain in-memory state a caller supplies. It is a
// PORT, not a shared import (browser TS vs. Node .mjs): keep it in sync by
// hand if rholang.ts's deploy path changes, the way rholang-macros.mjs already
// does for the macro registry.
//
// TRUST NOTE: holding a secp256k1 key in a headless agent is a deliberate,
// narrow, OPT-IN exception to this repo's "an agent never holds a signing
// key" invariant (see rholang-agent.mjs, which previews for a human to sign
// client-side instead). It exists only for a TEST-SYSTEM REV faucet
// (agent.mjs --key). Never point --key at a key that holds anything of real
// value — the key is held in process memory and can send REV to anyone who
// asks.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const DEFAULT_CONFIG = {
  url: "http://127.0.0.1:40403",
  shard: "root",
  phloLimit: 500_000,
  phloPrice: 1,
};

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const unhex = (s) => {
  const t = String(s).trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(t) || t.length % 2) throw new Error("not base16");
  return new Uint8Array((t.match(/../g) ?? []).map((p) => parseInt(p, 16)));
};

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = BASE58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = BASE58[0] + out; }
  return out;
}

/** The uncompressed (65-byte, `04…`) public key a deploy is attributed to. */
export function publicKeyOf(secretHex) {
  return hex(secp256k1.getPublicKey(unhex(secretHex), false));
}

/**
 * The REV address a deploy is charged to, derived the way rnode derives it
 * (rholang/src/util/rev_address.rs):
 *   eth     = last 20 bytes of keccak256(public key without its 0x04 prefix)
 *   payload = 00000000 ++ keccak256(eth)
 *   address = base58(payload ++ first 4 bytes of blake2b256(payload))
 */
export function revAddressOf(secretHex) {
  const pub = secp256k1.getPublicKey(unhex(secretHex), false);
  const eth = hex(keccak_256(pub.slice(1))).slice(-40);
  const payload = new Uint8Array([0, 0, 0, 0, ...keccak_256(unhex(eth))]);
  const checksum = blake2b(payload, { dkLen: 32 }).slice(0, 4);
  return base58(new Uint8Array([...payload, ...checksum]));
}

const ZBASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

function zbase32(data, bitLength) {
  let out = "";
  for (let p = 0; p < bitLength; p += 5) {
    let v = 0;
    for (let k = 0; k < 5; k++) {
      const i = p + k;
      v <<= 1;
      if (i < bitLength) v |= (data[i >> 3] >> (7 - (i % 8))) & 1;
    }
    out += ZBASE32[v];
  }
  return out;
}

/** The signed-registry uri this secret key writes to, and only this key can. */
export function registryUriOf(secretHex) {
  const pub = secp256k1.getPublicKey(unhex(secretHex), false);
  return "rho:id:" + zbase32(blake2b(pub, { dkLen: 32 }), 256);
}

// ---------------------------------------------------------------------------
// Protobuf encoding of DeployData — see rholang.ts for the field-number map;
// bytes must match rnode's DeployDataProto exactly (proto3 omits zero/empty
// fields, ascending field number).
// ---------------------------------------------------------------------------

function varint(n) {
  const out = [];
  let v = BigInt(n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

function fieldVarint(field, value) {
  if (value === 0) return [];
  return [...varint((field << 3) | 0), ...varint(value)];
}

function fieldString(field, value) {
  if (!value) return [];
  const bytes = new TextEncoder().encode(value);
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
}

/** DeployDataProto: term=2, timestamp=3, phloPrice=7, phloLimit=8, validAfterBlockNumber=10, shardId=11. */
export function encodeDeployData(d) {
  return new Uint8Array([
    ...fieldString(2, d.term),
    ...fieldVarint(3, d.timestamp),
    ...fieldVarint(7, d.phloPrice),
    ...fieldVarint(8, d.phloLimit),
    ...fieldVarint(10, d.validAfterBlockNumber),
    ...fieldString(11, d.shardId),
  ]);
}

/** Sign deploy data the way rnode verifies it: DER secp256k1 over blake2b256. */
export function signDeployData(d, secretHex) {
  const digest = blake2b(encodeDeployData(d), { dkLen: 32 });
  const sig = secp256k1.sign(digest, unhex(secretHex), { prehash: false, format: "der" });
  return { deployer: publicKeyOf(secretHex), signature: hex(sig) };
}

// ---------------------------------------------------------------------------
// The powerbox + program wrapper (see rholang.ts for the full rationale)
// ---------------------------------------------------------------------------

const POWERBOX = [
  { name: "stdout", urn: "rho:io:stdout" },
  { name: "zfa", urn: "rho:qucalc:zfa" },
  { name: "grant", urn: "rho:qucalc:grant" },
  { name: "verify", urn: "rho:qucalc:verify" },
  { name: "fuse", urn: "rho:qucalc:fuse" },
];

/**
 * If `body` is, in its entirety, a single top-level `new <decls> in { <inner> }`
 * (a hand-written program, or any `$macro` expansion — those always are) return
 * its parts so `wrapProgram` can MERGE rather than NEST. Otherwise null.
 * Verbatim port of rholang.ts's splitTopNew.
 */
export function splitTopNew(body) {
  const s = body.trim();
  let i = 0;
  const skipWsComments = () => {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s.startsWith("//", i)) { const e = s.indexOf("\n", i); i = e < 0 ? s.length : e; continue; }
      if (s.startsWith("/*", i)) { const e = s.indexOf("*/", i + 2); if (e < 0) return; i = e + 2; continue; }
      return;
    }
  };
  skipWsComments();
  if (!/^new\s/.test(s.slice(i))) return null;
  i += 3;
  const declStart = i;
  let depth = 0, inStr = false, declEnd = -1;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === inStr) inStr = false; else if (c === "\\") i++; continue; }
    if (c === '"' || c === "`") { inStr = c; continue; }
    if (c === "/" && s[i + 1] === "/") { const e = s.indexOf("\n", i); i = e < 0 ? s.length - 1 : e; continue; }
    if (c === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); if (e < 0) return null; i = e + 1; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && s.startsWith("in", i) && !/[A-Za-z0-9_']/.test(s[i - 1] ?? "") && !/[A-Za-z0-9_']/.test(s[i + 2] ?? "")) {
      declEnd = i; i += 2; break;
    }
  }
  if (declEnd < 0) return null;
  skipWsComments();
  if (s[i] !== "{") return null;
  const open = i;
  depth = 1; inStr = false; i = open + 1;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === inStr) inStr = false; else if (c === "\\") i++; continue; }
    if (c === '"' || c === "`") { inStr = c; continue; }
    if (c === "/" && s[i + 1] === "/") { const e = s.indexOf("\n", i); i = e < 0 ? s.length - 1 : e; continue; }
    if (c === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); if (e < 0) return null; i = e + 1; continue; }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) return null;
  const close = i;
  i = close + 1;
  skipWsComments();
  if (i < s.length) return null;
  const decls = s.slice(declStart, declEnd).trim();
  if (!/[A-Za-z_]/.test(decls)) return null;
  return { decls, inner: s.slice(open + 1, close) };
}

function declNames(decls) {
  return decls
    .split(",")
    .map((d) => /^\s*([A-Za-z_][A-Za-z0-9_']*)/.exec(d)?.[1])
    .filter((n) => !!n);
}

/** Wrap a program body. Verbatim port of rholang.ts's wrapProgram. */
export function wrapProgram(body, mode, nonce) {
  const ours = ["return", ...POWERBOX.map((e) => `${e.name}(\`${e.urn}\`)`)];
  if (nonce !== undefined) {
    ours.push("__insertSigned(`rho:registry:insertSigned:secp256k1`)",
              "__deployerId(`rho:rchain:deployerId`)", "__ack");
  }
  const forwarder = nonce === undefined ? "" :
    `\n  |\n  for (@__value <- return) {` +
    `\n    __insertSigned!((${Number(nonce)}, __value), *__deployerId, *__ack) |` +
    `\n    stdout!(__value)` +
    `\n  }`;

  const split = splitTopNew(body);
  if (split) {
    const taken = new Set(declNames(split.decls));
    const merged = [...ours.filter((d) => !taken.has(declNames(d)[0])), split.decls].filter(Boolean).join(", ");
    const inner = split.inner.replace(/^\n/, "").replace(/\n$/, "");
    return `new ${merged} in {\n${inner}${forwarder}\n}`;
  }

  const indented = body.split("\n").map((l) => (l.trim() ? "  " + l : l)).join("\n");
  return `new ${ours.join(", ")} in {\n${indented}${forwarder}\n}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const base = (cfg) => cfg.url.replace(/\/+$/, "");

async function getJson(cfg, path) {
  const res = await fetch(base(cfg) + path, { headers: { accept: "application/json" } });
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(text.slice(0, 200) || `HTTP ${res.status}`); }
}

async function postJson(cfg, path, body) {
  const res = await fetch(base(cfg) + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(text.slice(0, 200) || `HTTP ${res.status}`); }
}

export async function nodeStatus(cfg) {
  return await getJson(cfg, "/api/status");
}

/** Render one Par expression from rnode's JSON into readable text. Port of renderExpr. */
function renderExpr(e) {
  if (e === null || e === undefined) return "Nil";
  if (typeof e !== "object") return String(e);
  const o = e;
  if ("ExprInt" in o) return String(o.ExprInt);
  if ("ExprPar" in o) { const parts = o.ExprPar.map(renderExpr); return parts.length ? parts.join(" | ") : "Nil"; }
  if ("ExprString" in o) return JSON.stringify(o.ExprString);
  if ("ExprBool" in o) return String(o.ExprBool);
  if ("ExprBytes" in o) return `0x${String(o.ExprBytes)}`;
  if ("ExprUri" in o) return String(o.ExprUri);
  if ("ExprUnforg" in o) return "Unforgeable(…)";
  if ("ExprList" in o) return `[${o.ExprList.map(renderExpr).join(", ")}]`;
  if ("ExprTuple" in o) return `(${o.ExprTuple.map(renderExpr).join(", ")})`;
  if ("ExprSet" in o) return `Set(${o.ExprSet.map(renderExpr).join(", ")})`;
  if ("ExprMap" in o) { const entries = o.ExprMap ?? []; return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${renderExpr(v)}`).join(", ")}}`; }
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0].startsWith("Expr")) {
    const inner = o[keys[0]];
    if (Array.isArray(inner)) return inner.map(renderExpr).join(", ");
    if (inner !== null && typeof inner === "object") return renderExpr(inner);
    return String(inner);
  }
  return JSON.stringify(o);
}

/** Run a term without deploying it. Port of evalTerm (incl. finalized-fringe fallback). */
export async function evalTerm(cfg, term) {
  const unwrap = (r) => {
    if (typeof r === "string") throw new Error(r);
    const o = r ?? {};
    return { values: (o.expr ?? []).map(renderExpr), blockNumber: o.block?.blockNumber, blockHash: o.block?.blockHash };
  };
  const program = wrapProgram(term, "eval");
  try {
    return unwrap(await postJson(cfg, "/api/explore-deploy", program));
  } catch (e) {
    const msg = e?.message ?? "";
    if (!/finalized fringe/i.test(msg)) throw e;
    const blocks = await getJson(cfg, "/api/blocks/1");
    const blockHash = blocks?.[0]?.blockHash;
    if (!blockHash) throw e;
    return unwrap(await postJson(cfg, "/api/explore-deploy-by-block-hash", { term: program, blockHash, usePreStateHash: false }));
  }
}

/** The record with its nonce at this key's registry slot — {nonce, value}. Port of readResultRecord. */
export async function readResultRecord(cfg) {
  if (!cfg.key) return { nonce: null, value: null };
  const uri = registryUriOf(cfg.key);
  const r = await evalTerm(cfg, `new lookup(\`rho:registry:lookup\`), stored in {
  lookup!(\`${uri}\`, *stored) |
  for (@record <- stored) {
    match record { (_, (n, value)) => { return!((n, value)) }  _ => { Nil } }
  }
}`).catch(() => null);
  const raw = r?.values?.[0];
  if (raw == null) return { nonce: null, value: null };
  const mm = /^\(\s*(\d+)\s*,\s*([\s\S]*)\)\s*$/.exec(String(raw).trim());
  if (!mm) return { nonce: null, value: String(raw) };
  return { nonce: Number(mm[1]), value: mm[2].trim() };
}

/** Poll the record until it reports at `minNonce` or later. Port of readResultsFresh. */
async function readResultsFresh(cfg, minNonce, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const rec = await readResultRecord(cfg).catch(() => ({ nonce: null, value: null }));
    if (rec.value != null && (rec.nonce == null || rec.nonce >= minNonce)) return rec.value;
  }
  return null;
}

// A workflow can outlive the process, but the agent restarts rarely and the
// registry slot is the source of truth anyway — one in-memory nonce per rnode
// URL, seeded from that node's own slot on first use, mirrors rholang.ts's
// deployToNode (never touches a persisted config).
const nonceByUrl = new Map();

/**
 * Sign and deploy `term` with `cfg.key`. Returns the deploy outcome plus —
 * polled briefly from this key's result slot — the value the program sent to
 * `return`, or undefined if nothing landed within the wait window (a failed
 * revVault transfer may send nothing at all — a known rnode-build gap, see
 * CLAUDE.md's rholang "Known gaps").
 */
export async function deployTerm(cfg, term, { waitAttempts = 6 } = {}) {
  if (!cfg.key) return { ok: false, message: "no deploy key configured" };

  let nonce = nonceByUrl.get(cfg.url);
  if (nonce === undefined) {
    const rec = await readResultRecord(cfg).catch(() => ({ nonce: null }));
    nonce = (rec.nonce ?? 0) + 1;
  }
  nonceByUrl.set(cfg.url, nonce + 1);

  const status = await nodeStatus(cfg).catch(() => ({}));
  const data = {
    term: wrapProgram(term, "deploy", nonce),
    timestamp: Date.now(),
    phloPrice: cfg.phloPrice,
    phloLimit: cfg.phloLimit,
    validAfterBlockNumber: Math.max(0, (status.latestBlockNumber ?? 0) - 1),
    shardId: status.shardId || cfg.shard,
  };
  const { deployer, signature } = signDeployData(data, cfg.key);
  const reply = await postJson(cfg, "/api/deploy", { data, deployer, signature, sigAlgorithm: "secp256k1" });
  const text = typeof reply === "string" ? reply : JSON.stringify(reply);
  const ok = /success/i.test(text);
  if (!ok) return { ok, message: text };
  const value = await readResultsFresh(cfg, nonce, waitAttempts);
  return { ok, message: text, resultNonce: nonce, sig: signature, value: value ?? undefined };
}

// Run selftest when invoked directly with --selftest: derive the REV address
// for a known all-`01`-bytes test key and print it (rholang-editor.selftest.mjs-
// style smoke check — no network needed).
if (typeof process !== "undefined" && process.argv.includes("--selftest")) {
  const testKey = "0101010101010101010101010101010101010101010101010101010101010101".slice(0, 64);
  let ok = true;
  try {
    const addr = revAddressOf(testKey);
    if (!/^[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(addr)) { console.error("bad address shape:", addr); ok = false; }
    else console.log("revAddressOf smoke check:", addr);
    const uri = registryUriOf(testKey);
    if (!uri.startsWith("rho:id:")) { console.error("bad registry uri:", uri); ok = false; }
    else console.log("registryUriOf smoke check:", uri);
    const term = wrapProgram("return!(1)", "deploy", 1);
    if (!/__insertSigned/.test(term) || !/return!\(1\)/.test(term)) { console.error("wrapProgram shape unexpected"); ok = false; }
    else console.log("wrapProgram smoke check: ok");
  } catch (e) { console.error("selftest error:", e?.message ?? e); ok = false; }
  process.exit(ok ? 0 : 1);
}

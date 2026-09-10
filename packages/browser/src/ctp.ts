/// Capability transport — a bridge is a dual-shard account; the room is the venue.
///
/// A *bridge* is an identity that holds one account (one secp256k1 key) present
/// on two or more shards. Because a `deployerId` / REV address is derived from
/// the key and is shard-independent, "the same account on two shards" is
/// literally one key — and holding a funded account on both shards IS the
/// capability to bridge that pair. Bridges are permissionless and many coexist.
///
/// The *owner* of a bridge is an identity, unifying with issue #103 ("a group
/// is an identity"):
///   - a person — a dyncap anchor; the account key lives in `vault.ts`
///   - a group  — a group id (a cap token); the key lives in `Group.vaults`,
///     replicated to members via `gov-vault`
/// Personal ownership is the degenerate case (a group of one).
///
/// The *bridge room* is derived, not minted: its capability token is a pure
/// function of the owner id and the (unordered) shard pair, so every operator
/// computes the same address with nothing announced. It is private because the
/// address is only computable by the owner — the same predictable-derivation
/// idiom the deploy-result registry slot already uses (`registryUriOf`).
///
/// This module is pure — no DOM, no storage, no app imports beyond `zfa.ts`.
/// It mirrors `probe.ts` / `polls.ts` in that respect. The `/ctp` command
/// wiring, wire kinds, and stores live in `app.ts`; see `CapabilityTransport.md`.

import { sha256 } from "@noble/hashes/sha2.js";
import { isPauliClosed, validateCapability } from "./zfa.js";

// ---------------------------------------------------------------------------
// Bridge owner — a person (dyncap anchor) or a group (group id)
// ---------------------------------------------------------------------------

export type BridgeOwner =
  | { kind: "person"; anchor: string }
  | { kind: "group"; groupId: string };

/// The owner's canonical identifier string, for hashing and display.
/// A dyncap anchor is 64 hex; a group id is a `cap:` token — both are already
/// unambiguous, so the kind prefix only guards against a (vanishingly unlikely)
/// collision between the two namespaces.
export function ownerId(owner: BridgeOwner): string {
  return owner.kind === "person"
    ? `person:${owner.anchor}`
    : `group:${owner.groupId}`;
}

// ---------------------------------------------------------------------------
// Shard references
// ---------------------------------------------------------------------------

/// A shard is identified by its rnode HTTP base URL. Two operators must derive
/// the same room from "the same shard", so the URL is normalized: lowercased
/// host, no trailing slash, no default port. The rnode's self-reported
/// `shardId` is *not* used in the derivation — it is `"root"` for every
/// independent single-node chain, so it would not distinguish siblings.
export function normalizeShardRef(ref: string): string | null {
  const s = ref.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `http://${s}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const port =
    u.port && !((u.protocol === "http:" && u.port === "80") ||
                (u.protocol === "https:" && u.port === "443"))
      ? `:${u.port}`
      : "";
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${host}${port}${path}`;
}

/// A stable, order-independent id for a shard pair — for storage keys, vault
/// handles, and display. Short hash so it fits a handle; the full shard URLs
/// live in the `BridgeSpec`.
export function bridgePairKey(shardA: string, shardB: string): string {
  const a = normalizeShardRef(shardA);
  const b = normalizeShardRef(shardB);
  if (!a || !b) throw new Error("bridgePairKey: unparseable shard ref");
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return bytesToHex(sha256(utf8(`${lo}\n${hi}`))).slice(0, 16);
}

/// The `gov-vault` / `vault.ts` handle under which a bridge account key is
/// stored. Namespaced so it can never collide with a person's login handle.
export function bridgeVaultHandle(shardA: string, shardB: string): string {
  return `ctp:${bridgePairKey(shardA, shardB)}`;
}

// ---------------------------------------------------------------------------
// Deriving the bridge room
// ---------------------------------------------------------------------------

const ROOM_DOMAIN = "quantum-os/ctp-room:v1";

/// The maximum number of rejection-sampling iterations before we give up.
/// `bytesToTwists` makes the count balance hold by construction, so only Pauli
/// closure is sampled for — ~25% pass rate, so ~4 iterations expected and this
/// ceiling is never approached in practice.
const DERIVE_BUDGET = 100_000;

/// Derive the private room capability for a bridge between `shardA` and
/// `shardB` owned by `owner`. Deterministic: the same inputs always yield the
/// same `cap:room:<hex>` token, and the result passes `validateCapability`
/// (count balance ∧ Pauli closure), so it is a first-class room id.
///
/// Order-independent in the shard pair. Throws only if rejection sampling
/// somehow exhausts its (enormous) budget.
export function deriveBridgeRoom(owner: BridgeOwner, shardA: string, shardB: string): string {
  const a = normalizeShardRef(shardA);
  const b = normalizeShardRef(shardB);
  if (!a || !b) throw new Error("deriveBridgeRoom: unparseable shard ref");
  if (a === b) throw new Error("deriveBridgeRoom: a bridge needs two distinct shards");
  const [lo, hi] = a < b ? [a, b] : [b, a];

  const seedInput = utf8(`${ROOM_DOMAIN}\n${ownerId(owner)}\n${lo}\n${hi}`);
  let digest = sha256(seedInput); // 32 bytes

  for (let attempt = 0; attempt < DERIVE_BUDGET; attempt++) {
    // 16 bytes → 32 twists, matching a minted room cap's length.
    const twists = bytesToTwists(digest.subarray(0, 16));
    if (isPauliClosed(twists)) {
      const token = `cap:room:${twistsToHex(twists)}`;
      // Belt and braces: the derivation guarantees this, but a future change to
      // the kernel's predicate should fail loudly here, not ship a bad room id.
      if (!validateCapability(token)) {
        throw new Error("deriveBridgeRoom: derived token failed validation");
      }
      return token;
    }
    // Fresh pseudorandom bytes for the next attempt: re-hash with the counter.
    digest = sha256(concat(digest, u32be(attempt)));
  }
  throw new Error("deriveBridgeRoom: rejection sampling exceeded budget");
}

// ---------------------------------------------------------------------------
// Bridge spec — the record an operator stores per bridge
// ---------------------------------------------------------------------------

export interface BridgeSpec {
  owner: BridgeOwner;
  /// Normalized shard refs (rnode base URLs), as passed to `deriveBridgeRoom`.
  shardA: string;
  shardB: string;
  /// The derived private room capability. Cached; recomputable from the above.
  roomCap: string;
  /// Registry URIs of the `ctpEscrow` contract deployed on each shard, once
  /// known (`/ctp setup` fills these in). `rho:id:…`.
  escrowA?: string;
  escrowB?: string;
  /// Above this amount a transfer escalates to a `/gov` vote before its mint
  /// leg (group-owned bridges only; see `CapabilityTransport.md` Phase 4).
  /// `undefined` ⟹ no auto-execute ceiling recorded yet.
  autoThreshold?: number;
  /// When this operator first created / adopted the bridge (epoch ms).
  at: number;
}

/// Build a `BridgeSpec`, deriving the room. Pure — callers persist the result.
export function makeBridgeSpec(
  owner: BridgeOwner,
  shardA: string,
  shardB: string,
  at: number = Date.now(),
): BridgeSpec {
  const a = normalizeShardRef(shardA);
  const b = normalizeShardRef(shardB);
  if (!a || !b) throw new Error("makeBridgeSpec: unparseable shard ref");
  return {
    owner,
    shardA: a,
    shardB: b,
    roomCap: deriveBridgeRoom(owner, a, b),
    at,
  };
}

/// Re-derive and check a stored spec's `roomCap` — a spec whose room does not
/// match its inputs was tampered with or was written by an incompatible build.
export function bridgeSpecIsConsistent(spec: BridgeSpec): boolean {
  try {
    return deriveBridgeRoom(spec.owner, spec.shardA, spec.shardB) === spec.roomCap;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// byte helpers (kept local — this module has no other dependency)
// ---------------------------------------------------------------------------

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (n >>> 24) & 0xff;
  out[1] = (n >>> 16) & 0xff;
  out[2] = (n >>> 8) & 0xff;
  out[3] = n & 0xff;
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/// Deterministic byte → twist pair, identical to `bytesToTwists` in `zfa.ts`:
/// each byte yields [pos, neg] with pos ∈ {0,2,4,6}, neg ∈ {1,3,5,7} — so the
/// result is count-balanced by construction and only Pauli closure is sampled.
function bytesToTwists(bytes: Uint8Array): Uint8Array {
  const twists = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    twists[i * 2]     = ((b >> 4) & 0x3) * 2;
    twists[i * 2 + 1] = ((b & 0x3) * 2) + 1;
  }
  return twists;
}

/// Twist values 0–7 render as the single hex digits `0`–`7` — the `cap:` token
/// format (`zfa.ts` `formatCap`, `validateCapability`).
function twistsToHex(twists: Uint8Array): string {
  let hex = "";
  for (const t of twists) hex += t.toString(16);
  return hex;
}

// ===========================================================================
// The `/ctp` transport protocol
//
// A transfer moves value (or a capability) from a source shard to a
// destination shard through the bridge room. The wire kinds are dyncap-signed
// and follow the `/rdv` lineage; the on-shard legs are `ctpEscrow` deploys
// (`ctp-escrow.js`). This section is the pure protocol: the envelope shapes,
// their defensive validators (every one arrives from a peer), the deterministic
// nonce, the conservation check, and the state machine.
// ===========================================================================

export type CtpKind = "ctp-offer" | "ctp-lock" | "ctp-mint" | "ctp-receipt" | "ctp-abort";

/// A proposed transfer, broadcast into the bridge room by the initiator.
export interface CtpOffer {
  id: string;                 // transfer id — `newTransferId()`
  pair: string;               // `bridgePairKey(srcShard, dstShard)`
  srcShard: string;           // normalized rnode url — where value is locked
  dstShard: string;           // normalized rnode url — where it is minted
  what: "value" | "cap";
  amount?: string;            // decimal string, when what === "value"
  cap?: string;               // `cap:` token, when what === "cap" (Phase 5)
  destAddr: string;           // REV address on dstShard (or the proxy grantee)
  by: string;                 // initiator peer id
  at: number;
  expiresAt: number;
}

/// What `ctpEscrow.lock` returns and `ctp-lock` carries. Mirrors the rholang
/// tuple `("ctp-burn", shardId, subject, amount, nonce, destAddr)`.
export interface CtpBurnReceipt {
  tag: "ctp-burn";
  srcShard: string;
  subject: string;            // the address/id debited on the source shard
  amount: string;             // decimal string
  nonce: string;
  destAddr: string;
}

/// What `ctpEscrow.mint` returns and `ctp-mint` carries. Mirrors the rholang
/// tuple `("ctp-mint", shardId, destAddr, amount, nonce, srcShard)`.
export interface CtpMintReceipt {
  tag: "ctp-mint";
  dstShard: string;
  destAddr: string;
  amount: string;
  nonce: string;
  srcShard: string;
}

/// The permanent record, broadcast on completion and stored (non-transferable,
/// tombstone-aware) — the audit trail for a completed crossing.
export interface CtpReceipt {
  id: string;
  burn: CtpBurnReceipt;
  mint: CtpMintReceipt;
  srcBlock?: string;
  dstBlock?: string;
  at: number;
}

export type CtpStatus = "offered" | "locked" | "minted" | "receipted" | "aborted";

/// In-flight transfer state, kept per bridge room (not persisted — the
/// permanent record is the `CtpReceipt`; a reload rebuilds in-flight state from
/// the `ctp-*` envelopes still in the room, or the operator re-checks on chain).
export interface CtpTransfer {
  offer: CtpOffer;
  status: CtpStatus;
  burn?: CtpBurnReceipt;
  mint?: CtpMintReceipt;
  receipt?: CtpReceipt;
  abortReason?: string;
  updatedAt: number;
}

// --- ids and the deterministic nonce --------------------------------------

/// A fresh transfer id — 8 random bytes, hex (same shape as `newProposalId`).
export function newTransferId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// The escrow nonce for a transfer — a pure function of its id, so the `lock`
/// leg and the `mint` leg always agree and a replayed `ctp-mint` hits the
/// escrow's idempotency check rather than paying twice.
export function transferNonce(offerOrId: CtpOffer | string): string {
  const id = typeof offerOrId === "string" ? offerOrId : offerOrId.id;
  return `ctp-${id}`;
}

// --- conservation --------------------------------------------------------

/// The burn and the mint describe the same crossing: same nonce, same amount,
/// same destination. (The escrow enforces this on chain too — this is the
/// room's own check before it writes a `ctp-receipt`.)
export function ctpConservationCheck(burn: CtpBurnReceipt, mint: CtpMintReceipt): boolean {
  return (
    burn.tag === "ctp-burn" &&
    mint.tag === "ctp-mint" &&
    burn.nonce === mint.nonce &&
    burn.amount === mint.amount &&
    burn.destAddr === mint.destAddr &&
    burn.srcShard === mint.srcShard &&
    /^\d+$/.test(burn.amount)
  );
}

// --- the state machine --------------------------------------------------

export type CtpEvent =
  | { k: "lock"; burn: CtpBurnReceipt }
  | { k: "mint"; mint: CtpMintReceipt }
  | { k: "receipt"; receipt: CtpReceipt }
  | { k: "abort"; reason: string };

/// Advance a transfer. Ordering is enforced (`mint` needs a `lock`; nothing
/// follows `receipted` or `aborted` except an idempotent repeat of the same
/// step). An illegal transition returns the state unchanged — callers compare
/// identity to tell whether anything happened.
export function ctpAdvance(t: CtpTransfer, ev: CtpEvent, now: number = Date.now()): CtpTransfer {
  const done = t.status === "receipted" || t.status === "aborted";
  switch (ev.k) {
    case "lock": {
      if (t.status !== "offered" && !(t.status === "locked" && sameBurn(t.burn, ev.burn))) return t;
      if (ev.burn.tag !== "ctp-burn") return t;
      return { ...t, status: "locked", burn: ev.burn, updatedAt: now };
    }
    case "mint": {
      if (!t.burn) return t;
      if (t.status !== "locked" && !(t.status === "minted" && sameMint(t.mint, ev.mint))) return t;
      if (ev.mint.tag !== "ctp-mint" || !ctpConservationCheck(t.burn, ev.mint)) return t;
      return { ...t, status: "minted", mint: ev.mint, updatedAt: now };
    }
    case "receipt": {
      if (t.status !== "minted" && !(t.status === "receipted")) return t;
      if (!t.burn || !ctpConservationCheck(t.burn, ev.receipt.mint)) return t;
      return { ...t, status: "receipted", receipt: ev.receipt, updatedAt: now };
    }
    case "abort": {
      if (done) return t;
      return { ...t, status: "aborted", abortReason: ev.reason, updatedAt: now };
    }
  }
}

function sameBurn(a: CtpBurnReceipt | undefined, b: CtpBurnReceipt): boolean {
  return !!a && a.nonce === b.nonce && a.amount === b.amount && a.destAddr === b.destAddr;
}
function sameMint(a: CtpMintReceipt | undefined, b: CtpMintReceipt): boolean {
  return !!a && a.nonce === b.nonce && a.amount === b.amount && a.destAddr === b.destAddr;
}

// --- wire validators — every envelope arrives from a peer -----------------

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isAmount = (v: unknown): v is string => typeof v === "string" && /^\d{1,40}$/.test(v);

export function ctpOfferFromWire(x: unknown): CtpOffer | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (!isStr(o.id) || !isStr(o.pair) || !isStr(o.by) || !isStr(o.destAddr)) return null;
  const src = normalizeShardRef(String(o.srcShard ?? ""));
  const dst = normalizeShardRef(String(o.dstShard ?? ""));
  if (!src || !dst || src === dst) return null;
  if (bridgePairKey(src, dst) !== o.pair) return null;
  const what = o.what === "cap" ? "cap" : o.what === "value" ? "value" : null;
  if (!what) return null;
  if (what === "value" && !isAmount(o.amount)) return null;
  if (what === "cap" && !isStr(o.cap)) return null;
  const at = Number(o.at), expiresAt = Number(o.expiresAt);
  if (!Number.isFinite(at) || !Number.isFinite(expiresAt)) return null;
  return {
    id: o.id, pair: o.pair, srcShard: src, dstShard: dst, what,
    amount: what === "value" ? String(o.amount) : undefined,
    cap: what === "cap" ? String(o.cap) : undefined,
    destAddr: o.destAddr, by: o.by, at, expiresAt,
  };
}

export function burnReceiptFromWire(x: unknown): CtpBurnReceipt | null {
  if (!x || typeof x !== "object") return null;
  const b = x as Record<string, unknown>;
  if (b.tag !== "ctp-burn") return null;
  const srcShard = normalizeShardRef(String(b.srcShard ?? ""));
  if (!srcShard || !isStr(b.subject) || !isAmount(b.amount) || !isStr(b.nonce) || !isStr(b.destAddr)) return null;
  return { tag: "ctp-burn", srcShard, subject: b.subject, amount: String(b.amount), nonce: b.nonce, destAddr: b.destAddr };
}

export function mintReceiptFromWire(x: unknown): CtpMintReceipt | null {
  if (!x || typeof x !== "object") return null;
  const m = x as Record<string, unknown>;
  if (m.tag !== "ctp-mint") return null;
  const dstShard = normalizeShardRef(String(m.dstShard ?? ""));
  const srcShard = normalizeShardRef(String(m.srcShard ?? ""));
  if (!dstShard || !srcShard || !isStr(m.destAddr) || !isAmount(m.amount) || !isStr(m.nonce)) return null;
  return { tag: "ctp-mint", dstShard, srcShard, destAddr: m.destAddr, amount: String(m.amount), nonce: m.nonce };
}

export function ctpReceiptFromWire(x: unknown): CtpReceipt | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const burn = burnReceiptFromWire(r.burn);
  const mint = mintReceiptFromWire(r.mint);
  if (!isStr(r.id) || !burn || !mint || !ctpConservationCheck(burn, mint)) return null;
  const at = Number(r.at);
  return {
    id: r.id, burn, mint, at: Number.isFinite(at) ? at : Date.now(),
    srcBlock: isStr(r.srcBlock) ? r.srcBlock : undefined,
    dstBlock: isStr(r.dstBlock) ? r.dstBlock : undefined,
  };
}

// --- rholang tuple <-> CtpBurnReceipt (bridges ctp.ts <-> ctp-escrow.js) --

/// The rholang term text for a burn receipt, to hand to `mintProgram`.
export function burnReceiptToTuple(b: CtpBurnReceipt): string {
  const q = (s: string) => JSON.stringify(s);
  return `("ctp-burn", ${q(b.srcShard)}, ${q(b.subject)}, ${b.amount}, ${q(b.nonce)}, ${q(b.destAddr)})`;
}

/// Parse what `ctpEscrow.lock` returned — the rholang render of
/// `("ctp-burn", <str>, <str>, <int>, <str>, <str>)`. Tolerant of surrounding
/// whitespace; returns null on anything else (a `["dup nonce", …]` / error list,
/// or a shape this build renders differently).
export function burnReceiptFromTuple(s: string): CtpBurnReceipt | null {
  const m = /^\s*\(\s*"ctp-burn"\s*,\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*,\s*(\d{1,40})\s*,\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*\)\s*$/.exec(s);
  if (!m) return null;
  const unq = (x: string) => {
    try { return JSON.parse(x) as string; } catch { return null; }
  };
  const srcRaw = unq(m[1]), subject = unq(m[2]), nonce = unq(m[4]), destAddr = unq(m[5]);
  if (srcRaw == null || subject == null || nonce == null || destAddr == null) return null;
  const srcShard = normalizeShardRef(srcRaw) ?? srcRaw;
  return { tag: "ctp-burn", srcShard, subject, amount: m[3], nonce, destAddr };
}

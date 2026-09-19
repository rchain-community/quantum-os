// Room-keyed encryption for the control plane — the part of the Jitsi-shaped
// transport that keeps the relay untrusted.
//
// Every envelope a peer sends over the signaling socket (chat, lemmas, notes,
// polls, gov, sync — everything that is not a WebRTC handshake) is sealed with
// AES-256-GCM under a key derived from the ROOM CAPABILITY TOKEN. The server
// relays ciphertext it cannot open, and it is told only a hash of the token as
// the room's name, so it cannot join the room either. "Knowing the room token
// IS the capability to join" is thereby true against the relay, not only
// against strangers: without the token there is nothing to read, and with it
// there is nothing more to ask for.
//
// Symmetric only — HKDF-SHA256 and AES-GCM, no keypair — so this adds no
// factoring/discrete-log exposure to the core p2p path (SECURITY.md, "quantum
// security"). The sender's peerId is bound in as GCM additional data, so a
// relay that re-labels a ciphertext with another `from` produces a message no
// one can open. What this does NOT do: stop the relay REPLAYING a ciphertext
// under its original `from` — the dyncap-signed envelopes carry a monotonic
// seq and detect that; plain chat does not (SECURITY.md records it).
//
// Plain JS, no imports, on `globalThis.crypto.subtle` — the same code runs in
// the browser (peer.ts) and in Node ≥ 20 (scripts/qos-cli/qospeer.mjs), which
// is the point: two ports of a key derivation are two ways to disagree.
// `node packages/browser/src/room-crypto.js --selftest` covers it.

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Domain-separation strings. Bump the `v1` together if the scheme changes. */
const SALT = "qos-room-v1";
const INFO_KEY = "qos-room-key";
const INFO_ID = "qos-room-id";

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto unavailable (needs a secure context, or Node ≥ 20)");
  return s;
};

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function toB64(bytes) {
  let s = "";
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/**
 * What the server is told the room is called: hex SHA-256 over the token under
 * a domain tag. One-way, so the relay holds a name it cannot turn back into
 * the capability. Every peer derives the same string from the same token, so
 * nothing is coordinated. (An old build sends the raw token instead; the two
 * land in different server-side rooms and cannot see each other — a one-time
 * cut at rollout, not an ongoing compatibility mode.)
 */
export async function roomIdFor(token) {
  const d = await subtle().digest("SHA-256", enc.encode(`${INFO_ID}:${token}`));
  return toHex(d);
}

/**
 * The room key: HKDF-SHA256(ikm = token, salt, info) → AES-GCM-256, non-extractable.
 * Derived once per room per session and held in memory; never stored, never sent.
 */
export async function deriveRoomKey(token) {
  const s = subtle();
  const ikm = await s.importKey("raw", enc.encode(token), "HKDF", false, ["deriveKey"]);
  return s.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(SALT), info: enc.encode(INFO_KEY) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Seal one envelope: JSON → AES-GCM under `key`, `from` as additional data.
 * Returns base64(iv ‖ ciphertext‖tag). A fresh 96-bit random IV per message;
 * at the rates a chat room produces, the birthday bound is not a concern.
 */
export async function seal(key, from, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(from) },
    key,
    enc.encode(JSON.stringify(obj)),
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return toB64(out);
}

/**
 * Open one envelope sealed by `seal` with the same key and the same `from`.
 * Returns the parsed object, or null if it does not open (wrong room, wrong
 * sender label, tampered, or not ours) — a relay-side fault is never a throw
 * into the message loop.
 */
export async function open(key, from, payload) {
  try {
    const bytes = fromB64(payload);
    if (bytes.length < 12 + 16) return null;
    const pt = await subtle().decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: enc.encode(from) },
      key,
      bytes.subarray(12),
    );
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}

// ---- selftest -------------------------------------------------------------
const isMain = typeof process !== "undefined" && process.argv?.[1]
  && /room-crypto\.js$/.test(process.argv[1]) && process.argv.includes("--selftest");
if (isMain) {
  const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
  const token = "cap:room:05214747236101414325074505234721";
  const id = await roomIdFor(token);
  assert(/^[0-9a-f]{64}$/.test(id), "room id is 64 hex");
  assert(id === await roomIdFor(token), "room id is deterministic");
  assert(id !== await roomIdFor(token + "0"), "room id differs by token");
  assert(!id.includes("0521474723"), "room id does not leak the token");
  const key = await deriveRoomKey(token);
  const other = await deriveRoomKey("cap:room:11111111111111111111111111111111");
  const msg = { kind: "chat", text: "hello ✓ 日本", n: 3 };
  const sealed = await seal(key, "cap:peer:aaa", msg);
  assert(typeof sealed === "string" && sealed.length > 40, "sealed is base64");
  assert(JSON.stringify(await open(key, "cap:peer:aaa", sealed)) === JSON.stringify(msg), "round trip");
  assert(await open(key, "cap:peer:bbb", sealed) === null, "another sender label does not open it");
  assert(await open(other, "cap:peer:aaa", sealed) === null, "another room's key does not open it");
  const tampered = sealed.slice(0, 30) + (sealed[30] === "A" ? "B" : "A") + sealed.slice(31);
  assert(await open(key, "cap:peer:aaa", tampered) === null, "a flipped byte does not open");
  assert(await open(key, "cap:peer:aaa", "not base64!!") === null, "garbage returns null, not a throw");
  assert(sealed !== await seal(key, "cap:peer:aaa", msg), "fresh IV per message");
  console.log("room-crypto selftest: ok");
}

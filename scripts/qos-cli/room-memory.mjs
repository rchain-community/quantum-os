// The room's memory: the durable half of a QuantumOS room, factored out of
// qos-daemon.mjs so it can be carried by any peer.
//
// A room is p2p — its state lives in the browsers that are in it, and when the
// last one closes, it is gone. Whoever holds this keeps lemmas, currencies,
// note terms-series, governance groups, dyncap chains and the transcript on
// disk, and re-serves them to every peer that joins. That is what makes a room
// outlive the people in it.
//
// Two carriers use it. `qos-daemon.mjs` is a peer that does nothing else — no
// AI, no Claude subscription, and it fails only if the process dies. `agent.mjs
// --persist <dir>` folds the same duty into a role agent, which costs one fewer
// peer against the signaling server's room-size ceiling (see run-agents.sh) at
// the price of tying durability to an agent that also talks.
//
// The carrier owns identity, signing and the socket, and passes in `signedSend`.
// Everything here is store-and-forward: it never tallies, resolves or decides.

import fs from "node:fs";
import path from "node:path";
import { generateCapability, validateCapability, parseTwists, achievesZfa } from "./zfa.mjs";
import { verifyEnvelope, serializeChain, deserializeChain } from "./dyncap.mjs";

/** Envelope kinds the carrier must dyncap-sign for the state it re-serves to be trusted. */
export const MEMORY_SIGNED_KINDS = ["sync-lemmas", "sync-currencies", "sync-series", "sync-gov", "lemma", "note-declare"];

const readJSON = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } };
// Atomic: write a temp file in the same directory, then rename over the target.
// identity.json holds the dyncap seed — a crash mid-write leaves it truncated,
// readJSON falls back to null, and the daemon mints a FRESH identity: a forked
// dyncap chain against every peer's TOFU pin, and its `/gov trust` standing
// (keyed by peerId) silently gone.
const writeJSON = (p, obj) => {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(p)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
};

// Lemma names are canonicalized (trim + collapse inner whitespace) to match the
// browser's canonLemma, so multi-word names (referenced as @[name with spaces])
// key identically here and the daemon's first-write-wins agrees with the browser.
const canonLemma = (name) => String(name ?? "").trim().replace(/\s+/g, " ");

// Terms-series stamp: FNV-1a 32-bit → 8 hex, byte-for-byte the browser's
// termsHash8 (notes.ts). A note-series declaration is trustworthy when its terms
// hash to the stamp baked in the series id (self-verifying commitment).
const termsHash8 = (text) => {
  const s = String(text ?? "").trim().replace(/\s+/g, " ");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
};

/**
 * Open a room's memory under `stateDir`.
 *
 * `signedSend(peerId, envelope)` must sign MEMORY_SIGNED_KINDS; `log`/`warn`
 * carry the carrier's own tag. Returns the handful of things a carrier wires
 * into its peer: serve on channel-open, ingest on message, transcribe, and a
 * flush for shutdown.
 */
export function openRoomMemory({ roomId, stateDir, myName, signedSend, log = console.log, warn = console.warn, verbose = false, seedLemmas = [], serveName = true }) {
  const roomHex = roomId.replace(/^cap:room:/, "");
  const roomDir = path.join(stateDir, "rooms", roomHex);
  const lemmasPath = path.join(roomDir, "lemmas.json");
  const currenciesPath = path.join(roomDir, "currencies.json");
  const chainsPath = path.join(roomDir, "chains.json");
  const seriesPath = path.join(roomDir, "series.json");
  const groupsPath = path.join(roomDir, "groups.json");
  const retractedPath = path.join(roomDir, "retracted.json");
  const transcriptPath = path.join(roomDir, "transcript.jsonl");

// ---- per-room stores ----
const lemmas = new Map(Object.entries(readJSON(lemmasPath, {})));       // name -> {twists,who,cap?,dyncap?}
const currencies = new Map(Object.entries(readJSON(currenciesPath, {})));// token -> {currency,token,issuer,dyncap?}
const seriesTerms = new Map(Object.entries(readJSON(seriesPath, {})));    // seriesKey ("USD~hash") -> {seriesKey,baseCurrency,termsHash,terms,issuer,dyncap?}
const groups = new Map(Object.entries(readJSON(groupsPath, {})));         // groupId -> Group (members, delegations, topicDelegations, issues, treasury?, kudos?)
const chains = deserializeChain(fs.existsSync(chainsPath) ? fs.readFileSync(chainsPath, "utf8") : "{}");
const retracted = new Set(readJSON(retractedPath, []));                  // canonical lemma names + "group:<id>" retracted by their owner
const peerNames = new Map();
const persistLemmas = () => writeJSON(lemmasPath, Object.fromEntries(lemmas));
const persistCurrencies = () => writeJSON(currenciesPath, Object.fromEntries(currencies));
const persistSeries = () => writeJSON(seriesPath, Object.fromEntries(seriesTerms));
const persistGroups = () => writeJSON(groupsPath, Object.fromEntries(groups));
const persistRetracted = () => writeJSON(retractedPath, [...retracted]);
const groupIsAdmin = (g, peerId) => peerId === g.creator || g.members?.[peerId]?.role === "admin";
const persistChains = () => writeJSON(chainsPath, JSON.parse(serializeChain(chains)));
const transcribe = (from, msg) => { try { fs.mkdirSync(roomDir, { recursive: true }); fs.appendFileSync(transcriptPath, JSON.stringify({ t: new Date().toISOString(), from, msg }) + "\n"); } catch {} };

  // Seed durable lemmas. Mint ZFA-valid twists so receiving peers accept them on
  // sync (achievesZfa gate). First-writer-wins by name: skip if already held.
  let seeded = 0;
  for (const lraw of seedLemmas ?? []) {
    const lname = canonLemma(lraw);
    if (!lname || lemmas.has(lname) || retracted.has(lname)) continue;
    const label = (lname.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "lemma");
    const cap = generateCapability(label);
    const twists = cap.split(":")[2];
    if (!achievesZfa(parseTwists(twists))) continue;
    lemmas.set(lname, { twists, who: myName, cap });
    seeded++;
    log(`seeded lemma "${lname.slice(0, 48)}${lname.length > 48 ? "…" : ""}"  ${cap.slice(0, 22)}…`);
  }
  if (seeded) persistLemmas();

const _servedAt = new Map();   // peerId -> last full-state serve
const _servedSig = new Map();   // peerId -> signature of the state last served to them
const SERVE_COOLDOWN_MS = 15_000;

// A cheap fingerprint of everything serveStateTo would send. Two serves with the
// same signature carry identical (idempotent, first-write-wins) payloads, so the
// second is pure cost.
function stateSignature() {
  const lem = [...lemmas.entries()].map(([n, e]) => `${n}=${e.twists}`).sort().join(",");
  const cur = [...currencies.keys()].sort().join(",");
  const ser = [...seriesTerms.keys()].sort().join(",");
  const gov = [...groups.values()].map((g) => `${g.id}:${JSON.stringify(g).length}`).sort().join(",");
  return `${lem}|${cur}|${ser}|${gov}`;
}

function serveStateTo(peerId) {
  // The whole payload is idempotent (first-write-wins on the receiver), so
  // re-serving it because a data channel briefly flapped is pure cost — and
  // when a connection is unstable that flap repeats, which is how one bad link
  // turned into thousands of "serving state" lines and a pegged core.
  //
  // Two guards: a short cooldown absorbs a rapid reconnect burst, and — because a
  // genuinely flapping peer would still earn one full serve every window forever —
  // we also skip any re-serve whose payload is byte-for-byte what this peer last
  // got. A real new joiner has no signature on file; a peer whose only "change" is
  // that its channel bounced has the same one, and gets nothing.
  const now = Date.now();
  if (now - (_servedAt.get(peerId) ?? 0) < SERVE_COOLDOWN_MS) return;
  const sig = stateSignature();
  if (_servedSig.get(peerId) === sig) { _servedAt.set(peerId, now); return; }
  _servedAt.set(peerId, now);
  _servedSig.set(peerId, sig);
  log(`serving state to ${peerId.slice(0, 12)}…`);
  // Only announce a name when the carrier has no announce of its own. A role
  // agent's announce carries `agent: <role>`, which is what puts the 🤖 AI badge
  // on it in the browser — and the browser CLEARS that badge on any name
  // envelope without the field. So a bare name from here would silently strip
  // the marker off the very agent that sent it.
  if (serveName) signedSend(peerId, { kind: "name", name: myName });
  signedSend(peerId, { kind: "sync-lemmas", entries: [...lemmas.entries()].map(([name, e]) => ({ name, twists: e.twists, who: e.who, cap: e.cap, dyncap: e.dyncap })) });
  signedSend(peerId, { kind: "sync-currencies", entries: [...currencies.values()] });
  if (seriesTerms.size) signedSend(peerId, { kind: "sync-series", entries: [...seriesTerms.values()] });
  if (groups.size) signedSend(peerId, { kind: "sync-gov", groups: [...groups.values()] });
}

async function verifyChain(from, d) {
  if (!d || typeof d !== "object" || !d.dyncap) return;
  const res = await verifyEnvelope(chains.get(from), roomId, d, d.dyncap);
  if (res.kind === "fork") { warn(`⚠ fork from ${from.slice(0, 12)}… at seq ${res.seq} (identity contested)`); }
  else if (res.kind === "anchor-mismatch") { warn(`⚠ anchor mismatch from ${from.slice(0, 12)}…`); }
  if (res.entry) { chains.set(from, res.entry); persistChains(); }
}

function ingestLemma(e, fromName) {
  if (!e || typeof e.name !== "string" || typeof e.twists !== "string") return false;
  const name = canonLemma(e.name);
  if (!name || retracted.has(name)) return false;        // tombstoned — don't resurrect
  const tw = parseTwists(e.twists);
  if (!tw || !achievesZfa(tw)) return false;
  const existing = lemmas.get(name);
  if (existing) { return existing.twists === e.twists; } // FWW + immutability
  lemmas.set(name, { twists: e.twists, who: e.who ?? fromName, cap: e.cap, dyncap: e.dyncap });
  return true;
}
function ingestCurrency(e, fromName) {
  if (!e || typeof e.token !== "string" || typeof e.currency !== "string") return false;
  // A currency authority token is cap:token-<currency>:<hex> (mintCurrencyToken
  // in notes.ts; the browser checks parseNoteLabel.kind === "token"). The old
  // "cap:currency:" prefix never matched, so currencies were silently dropped.
  if (!e.token.startsWith(`cap:token-${e.currency}:`) || !validateCapability(e.token)) return false;
  if (currencies.has(e.token)) return false; // FWW by token
  currencies.set(e.token, { currency: e.currency, token: e.token, issuer: e.issuer ?? fromName, dyncap: e.dyncap });
  return true;
}
// Ingest a note terms-series declaration. `senderAnchor` is the sender's
// verified dyncap anchor (or undefined). `requireIssuer` is true for a live
// note-series (the sender claims to BE the issuer) and false for a forwarded
// sync-series (the stamp self-commits to the terms, so a forwarder can't fake
// them). FWW by seriesKey.
function ingestSeries(e, fromName, senderAnchor, requireIssuer) {
  if (!e || typeof e.seriesKey !== "string" || typeof e.terms !== "string") return false;
  const { seriesKey, baseCurrency, termsHash, terms } = e;
  if (typeof baseCurrency !== "string" || typeof termsHash !== "string") return false;
  // Self-consistency: the series id must be base~hash and the stamp must
  // commit to exactly these terms.
  if (termsHash8(terms) !== termsHash || seriesKey !== `${baseCurrency}~${termsHash}`) return false;
  if (requireIssuer) {
    // If we know who issues baseCurrency, the sender must be that issuer.
    const known = [...currencies.values()].find((c) => c.currency === baseCurrency);
    if (known?.dyncap?.anchor && senderAnchor && known.dyncap.anchor !== senderAnchor) return false;
  }
  if (seriesTerms.has(seriesKey)) return false; // FWW by series id
  seriesTerms.set(seriesKey, { seriesKey, baseCurrency, termsHash, terms, issuer: e.issuer ?? fromName, dyncap: e.dyncap });
  return true;
}
// Merge a Group from a sync-gov handshake: adopt unknown (unless tombstoned),
// else union members / delegations / topic delegations / issues / treasury by
// latest `at`. The daemon only stores + re-serves groups (no tally), so this
// is a coarse structural merge of the signed group record.
function mergeGroup(raw) {
  if (!raw || typeof raw !== "object") return false;
  const id = String(raw.id ?? ""); if (!id || retracted.has("group:" + id)) return false;
  const ex = groups.get(id);
  if (!ex) {
    groups.set(id, {
      id, name: String(raw.name ?? ""), creator: String(raw.creator ?? ""), creatorLabel: String(raw.creatorLabel ?? "?"),
      createdAt: raw.createdAt ?? 0,
      members: (raw.members && typeof raw.members === "object") ? raw.members : {},
      delegations: (raw.delegations && typeof raw.delegations === "object") ? raw.delegations : {},
      topicDelegations: (raw.topicDelegations && typeof raw.topicDelegations === "object") ? raw.topicDelegations : {},
      issues: Array.isArray(raw.issues) ? raw.issues : [],
      ...(typeof raw.treasury === "string" ? { treasury: raw.treasury } : {}),
      ...(typeof raw.kudos === "string" ? { kudos: raw.kudos } : {}),
      ...(raw.vaults && typeof raw.vaults === "object" ? { vaults: raw.vaults } : {}),
    });
    return true;
  }
  let changed = false;
  for (const [pid, m] of Object.entries((raw.members && typeof raw.members === "object") ? raw.members : {})) {
    const cur = ex.members?.[pid]; if (!cur || (m.at ?? 0) > (cur.at ?? 0)) { (ex.members ??= {})[pid] = m; changed = true; }
  }
  for (const [pid, dl] of Object.entries((raw.delegations && typeof raw.delegations === "object") ? raw.delegations : {})) {
    const cur = ex.delegations?.[pid]; if (dl?.delegate && (!cur || (dl.at ?? 0) > (cur.at ?? 0))) { (ex.delegations ??= {})[pid] = dl; changed = true; }
  }
  for (const [iid, mp] of Object.entries((raw.topicDelegations && typeof raw.topicDelegations === "object") ? raw.topicDelegations : {})) {
    for (const [pid, dl] of Object.entries(mp || {})) { const cur = ex.topicDelegations?.[iid]?.[pid]; if (dl?.delegate && (!cur || (dl.at ?? 0) > (cur.at ?? 0))) { ex.topicDelegations ??= {}; (ex.topicDelegations[iid] ??= {})[pid] = dl; changed = true; } }
  }
  for (const i of Array.isArray(raw.issues) ? raw.issues : []) {
    const iid = String(i.id ?? ""); if (!iid) continue;
    const cur = (ex.issues ??= []).find((x) => x.id === iid);
    if (!cur) { ex.issues.push(i); changed = true; } else if (i.pollId && !cur.pollId) { cur.pollId = String(i.pollId); changed = true; }
  }
  if (typeof raw.treasury === "string" && !ex.treasury) { ex.treasury = raw.treasury; changed = true; }
  if (typeof raw.kudos === "string" && !ex.kudos) { ex.kudos = raw.kudos; changed = true; }
  // Members' encrypted identity vaults (handle -> record). LWW by `at`, same-anchor
  // overwrite only (squat-proof). Ciphertext only — the daemon can't decrypt it.
  for (const [h, v] of Object.entries((raw.vaults && typeof raw.vaults === "object") ? raw.vaults : {})) {
    if (!v || typeof v.blob !== "string" || !v.blob.startsWith("qos-vault:v1:") || typeof v.anchor !== "string" || v.anchor.length !== 64) continue;
    const at = typeof v.at === "number" ? v.at : 0;
    const cur = (ex.vaults ??= {})[h];
    if (cur && (cur.anchor !== v.anchor || at <= cur.at)) continue;
    ex.vaults[h] = { handle: String(v.handle ?? h), anchor: v.anchor, blob: v.blob, at };
    changed = true;
  }
  return changed;
}

async function ingest(from, d) {
  // The overlay's own liveness beacon (qospeer.mjs's periodic flood, kept for
  // isReachable) — every ~30s per present peer, and not room content, so it
  // doesn't belong in a durable transcript meant to capture what happened.
  if (d && typeof d === "object" && d.kind === "presence") return;
  if (verbose) log(` ⇐ ${from.slice(0, 8)}… ${typeof d === "object" ? JSON.stringify(d).slice(0, 200) : d}`);
  transcribe(from, d);
  if (!d || typeof d !== "object") return;
  await verifyChain(from, d);
  const fromName = peerNames.get(from) ?? from.slice(0, 8);
  switch (d.kind) {
    case "name": if (typeof d.name === "string") peerNames.set(from, d.name); break;
    case "chat": console.log(`[${peerNames.get(from) ?? from.slice(0, 8)}…] ${d.text}`); break;
    case "qlf": console.log(`[${peerNames.get(from) ?? from.slice(0, 8)}… /${d.cmd}] ${(d.lines || []).join(" | ")}`); break;
    case "lemma": if (ingestLemma(d, fromName)) { persistLemmas(); log(`+lemma "${d.name}"`); } break;
    case "note-declare": if (ingestCurrency({ currency: d.currency, token: d.token, dyncap: d.dyncap }, fromName)) { persistCurrencies(); log(`+currency "${d.currency}"`); } break;
    case "sync-lemmas": { let n = 0; for (const e of d.entries || []) if (ingestLemma(e, fromName)) n++; if (n) { persistLemmas(); log(`+${n} lemma(s) via sync`); } break; }
    case "sync-currencies": { let n = 0; for (const e of d.entries || []) if (ingestCurrency(e, fromName)) n++; if (n) { persistCurrencies(); log(`+${n} currency/ies via sync`); } break; }
    case "note-series": { const senderAnchor = chains.get(from)?.anchor; if (ingestSeries(d, fromName, senderAnchor, true)) { persistSeries(); log(`+terms-series "${d.seriesKey}"`); } break; }
    case "sync-series": { let n = 0; for (const e of d.entries || []) if (ingestSeries(e, fromName, undefined, false)) n++; if (n) { persistSeries(); log(`+${n} terms-series via sync`); } break; }
    // Governance: persist + re-serve groups so they survive when every browser
    // leaves. Mutations are gated like the browser (admin by peerId; delegations
    // self-signed). The daemon stores state only — no tally/resolver.
    case "group-open": {
      const id = String(d.id ?? "");
      if (!id || groups.has(id) || retracted.has("group:" + id)) break;
      groups.set(id, { id, name: String(d.name ?? ""), creator: from, creatorLabel: String(d.creatorLabel ?? fromName), createdAt: typeof d.createdAt === "number" ? d.createdAt : 0, members: { [from]: { peerId: from, role: "admin", label: String(d.creatorLabel ?? fromName), at: 0 } }, delegations: {}, topicDelegations: {}, issues: [] });
      persistGroups(); log(`+group "${groups.get(id).name}"`); break;
    }
    case "group-member": {
      const g = groups.get(String(d.groupId ?? "")); if (!g || !groupIsAdmin(g, from)) break;
      const pid = String(d.peerId ?? ""); if (!pid) break;
      if (d.remove === true) { delete g.members[pid]; if (g.delegations) delete g.delegations[pid]; }
      else g.members[pid] = { peerId: pid, role: d.role === "admin" ? "admin" : "member", label: String(d.label ?? pid.slice(0, 8)), at: 0 };
      persistGroups(); break;
    }
    case "group-meta": {
      const g = groups.get(String(d.groupId ?? "")); if (!g || !groupIsAdmin(g, from)) break;
      if (typeof d.treasury === "string") g.treasury = d.treasury;
      if (typeof d.kudos === "string") g.kudos = d.kudos;
      persistGroups(); break;
    }
    case "gov-delegate": {
      const g = groups.get(String(d.groupId ?? "")); const delegator = String(d.delegator ?? from);
      if (!g || from !== delegator || !g.members?.[delegator]) break;
      const delegate = d.delegate == null ? null : String(d.delegate);
      const iid = d.issueId ? String(d.issueId) : null;
      if (!(delegate === null || (g.members?.[delegate] && delegate !== delegator))) break;
      if (iid) { g.topicDelegations ??= {}; const m = (g.topicDelegations[iid] ??= {}); if (delegate === null) delete m[delegator]; else m[delegator] = { delegate, at: 0 }; if (Object.keys(m).length === 0) delete g.topicDelegations[iid]; }
      else if (delegate === null) delete g.delegations[delegator]; else g.delegations[delegator] = { delegate, at: 0 };
      persistGroups(); break;
    }
    case "gov-vault": {
      // A member replicates their password-encrypted identity into the group so
      // they can recover it in a new browser. Self-signed: sender's verified
      // anchor must equal the vault's anchor. FWW by handle; same-anchor newer-only.
      const g = groups.get(String(d.groupId ?? "")); if (!g) break;
      const senderAnchor = chains.get(from)?.anchor;
      const isMem = !!g.members?.[from] || (senderAnchor && Object.values(g.members || {}).some((m) => m.anchor === senderAnchor));
      if (!isMem) break;
      const handle = String(d.handle ?? "").trim().toLowerCase().replace(/\s+/g, " ");
      const blob = String(d.blob ?? ""); const anchor = String(d.anchor ?? "");
      const at = typeof d.at === "number" ? d.at : 0;
      if (!handle || anchor.length !== 64 || !blob.startsWith("qos-vault:v1:") || senderAnchor !== anchor) break;
      g.vaults ??= {};
      const cur = g.vaults[handle];
      if (cur && (cur.anchor !== anchor || at <= cur.at)) break;
      g.vaults[handle] = { handle, anchor, blob, at };
      persistGroups(); log(`+vault "${handle}"`); break;
    }
    case "group-issue": {
      const g = groups.get(String(d.groupId ?? "")); if (!g || !g.members?.[from]) break;
      const iss = d.issue; if (!iss || typeof iss !== "object" || !iss.title) break;
      const iid = String(iss.id ?? ""); if (!iid) break;
      if (!(g.issues ??= []).find((x) => x.id === iid)) { g.issues.push({ id: iid, title: String(iss.title), by: String(iss.by ?? fromName), at: typeof iss.at === "number" ? iss.at : 0, status: iss.status === "closed" ? "closed" : "open", pollId: iss.pollId ? String(iss.pollId) : undefined }); persistGroups(); }
      break;
    }
    case "group-vote": {
      const g = groups.get(String(d.groupId ?? "")); if (!g || !g.members?.[from]) break;
      const iss = (g.issues ?? []).find((x) => x.id === String(d.issueId ?? "")); if (iss) { iss.pollId = String(d.pollId ?? ""); iss.status = "open"; persistGroups(); } break;
    }
    case "sync-gov": { let n = 0; for (const raw of d.groups || []) if (mergeGroup(raw)) n++; if (n) { persistGroups(); log(`+${n} group(s) via sync`); } break; }
    case "retract": {
      // Honor owner retractions so an always-on memory peer doesn't resurrect
      // what an author removed. Lemma: author by anchor. Group: creator by peerId.
      if (d.what === "lemma") {
        const name = canonLemma(d.id);
        const entry = lemmas.get(name);
        const senderAnchor = chains.get(from)?.anchor;
        if (!entry || !entry.dyncap?.anchor || !senderAnchor || entry.dyncap.anchor !== senderAnchor) break;
        lemmas.delete(name); retracted.add(name); persistLemmas(); persistRetracted();
        log(`-lemma "${name}" retracted by author ${fromName}`);
      } else if (d.what === "group") {
        const id = String(d.id ?? ""); const g = groups.get(id);
        if (!g || from !== g.creator) break;            // only the creator disbands
        groups.delete(id); retracted.add("group:" + id); persistGroups(); persistRetracted();
        log(`-group "${g.name}" disbanded by ${fromName}`);
      }
      break;
    }
  }
}

  return {
    counts: () => ({ lemmas: lemmas.size, currencies: currencies.size, series: seriesTerms.size, groups: groups.size }),
    summary: () => `${lemmas.size} lemma(s), ${currencies.size} curr/ies, ${seriesTerms.size} terms-series, ${groups.size} group(s)`,
    serveStateTo,
    forgetPeer: (id) => { _servedAt.delete(id); _servedSig.delete(id); },
    ingest,
    transcribe,
    setPeerName: (id, name) => peerNames.set(id, name),
    anchorOf: (id) => chains.get(id)?.anchor,
    flush: () => { try { persistLemmas(); persistCurrencies(); persistSeries(); persistGroups(); persistChains(); persistRetracted(); } catch {} },
  };
}

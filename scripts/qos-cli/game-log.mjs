// Game recorder for the room-agent daemon (`agent.mjs`) — the `observer` role's instrument.
//
// An observer is a peer with no potency: it reads the room and records. Between
// `/observer start …` and `/observer stop` it appends EVERY inbound envelope it sees
// (polls, estimates, lemmas, chat, qlf actions — timestamped on receipt, with the
// sender's dyncap signature) to an append-only events file, then materializes that
// raw log into one structured game record. Two layers, deliberately:
//
//   games/<ts>-<slug>.events.jsonl   the data — lossless, {t, from, msg}, never edited
//   games/<ts>-<slug>.json           the record — polls with every ballot and both the
//                                    raw and trust-weighted tally, estimate rounds,
//                                    lemmas (commitments), chat, participants w/ anchors
//   games/<ts>-<slug>.summary.md     the reading — the AI summary, citing the exact
//                                    event range it summarizes (agent.mjs writes it)
//
// The `start` command text is the pre-registration: it is in the shared transcript,
// timestamped and signed by whoever typed it, BEFORE any round is played.
//
// Analysis lives in the QLF repo (`game_log_analysis.py`), which reads the .json.

import fs from "node:fs";
import path from "node:path";

export const GAME_SCHEMA = "qos-game/1";

const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "game";

/** Parse the free text after `/observer start`. Recognized:
 *    <label> [payoffs a,b,c,d] [stag=<option text>] [hare=<option text>] [predict: …]
 *  Everything is optional except the label; the raw text is kept verbatim. */
export function parseSpec(raw) {
  const text = String(raw || "").trim();
  const spec = { raw: text, label: "", payoffs: null, stag: null, hare: null, predictions: [] };
  let rest = text;
  const pm = rest.match(/\bpayoffs?\s*[:=]?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i);
  if (pm) { spec.payoffs = { a: +pm[1], b: +pm[2], c: +pm[3], d: +pm[4] }; rest = rest.replace(pm[0], " "); }
  const sm = rest.match(/\bstag\s*=\s*("[^"]+"|\S+)/i);
  if (sm) { spec.stag = sm[1].replace(/^"|"$/g, ""); rest = rest.replace(sm[0], " "); }
  const hm = rest.match(/\bhare\s*=\s*("[^"]+"|\S+)/i);
  if (hm) { spec.hare = hm[1].replace(/^"|"$/g, ""); rest = rest.replace(hm[0], " "); }
  const prm = rest.match(/\bpredict(?:ions?)?\s*[:=]?\s*([\s\S]+)$/i);
  if (prm) { spec.predictions = prm[1].split(/\s*;\s*|\s*\|\s*/).map((s) => s.trim()).filter(Boolean); rest = rest.replace(prm[0], " "); }
  spec.label = rest.replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim() || "game";
  return spec;
}

// ---- tallies (ports of packages/browser/src/polls.ts, plus weights) ----
export function tallyApproval(options, ballots, weights = {}) {
  const w = (p) => (weights[p] ?? 1);
  const counts = Object.fromEntries(options.map((o) => [o.id, 0]));
  let total = 0;
  for (const [peer, choices] of Object.entries(ballots)) {
    total += w(peer);
    for (const c of choices) if (c in counts) counts[c] += w(peer);
  }
  const max = Math.max(0, ...Object.values(counts));
  const winners = options.filter((o) => counts[o.id] === max && max > 0).map((o) => o.id);
  return { method: "approval", counts, winners, totalBallots: total };
}

export function tallyRanked(options, ballots, weights = {}) {
  const w = (p) => (weights[p] ?? 1);
  const ids = new Set(options.map((o) => o.id));
  let live = new Set(ids);
  const rounds = [];
  const total = Object.keys(ballots).reduce((s, p) => s + w(p), 0);
  for (let r = 0; r < options.length + 1; r++) {
    const counts = Object.fromEntries([...live].map((id) => [id, 0]));
    let exhausted = 0;
    for (const [peer, order] of Object.entries(ballots)) {
      const first = (order || []).find((c) => live.has(c));
      if (first === undefined) exhausted += w(peer); else counts[first] += w(peer);
    }
    const active = total - exhausted;
    const sorted = [...live].sort((x, y) => counts[y] - counts[x]);
    if (!sorted.length) { rounds.push({ counts, eliminated: null, exhausted }); break; }
    if (counts[sorted[0]] > active / 2 || live.size === 1) {
      rounds.push({ counts, eliminated: null, exhausted });
      return { method: "ranked", rounds, winners: [sorted[0]], totalBallots: total };
    }
    const min = Math.min(...sorted.map((id) => counts[id]));
    const losers = sorted.filter((id) => counts[id] === min);
    if (losers.length === live.size) {                    // all tied
      rounds.push({ counts, eliminated: null, exhausted });
      return { method: "ranked", rounds, winners: [...live], totalBallots: total };
    }
    const elim = losers[losers.length - 1];
    rounds.push({ counts, eliminated: elim, exhausted });
    live.delete(elim);
  }
  return { method: "ranked", rounds, winners: [...live], totalBallots: total };
}

/** Trust weights from a persisted groups.json (the memory carrier's), if any group
 *  in the room carries ratings: weight = 1 + trustLevel, else flat 1. */
export function trustWeightsFromGroups(groupsPath, trustLevels, groupHasRatings) {
  try {
    if (!fs.existsSync(groupsPath)) return null;
    const groups = JSON.parse(fs.readFileSync(groupsPath, "utf8"));
    const weights = {};
    let any = false;
    for (const g of Object.values(groups)) {
      if (!g || !groupHasRatings(g)) continue;
      any = true;
      const lv = trustLevels(g);
      for (const [p, l] of Object.entries(lv)) weights[p] = Math.max(weights[p] ?? 0, 1 + (l || 0));
    }
    return any ? weights : null;
  } catch { return null; }
}

/** Replay an events file into a structured game record. `nameOf(peer)` labels peers. */
export function materialize(eventsPath, header, { nameOf = (p) => p, weights = null } = {}) {
  const lines = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean) : [];
  const events = [];
  for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} }
  const participants = {};
  const seen = (peer, msg, t) => {
    const p = (participants[peer] ??= { name: nameOf(peer), anchor: null, firstSeen: t, messages: 0 });
    p.messages++;
    if (msg?.dyncap?.anchor && !p.anchor) p.anchor = msg.dyncap.anchor;
    if (msg?.kind === "name" && typeof msg.name === "string") p.name = msg.name;
  };
  const polls = new Map();
  const estimates = new Map();
  const lemmas = [];
  const chat = [];
  const qlf = [];
  const retracted = [];
  for (const { t, from, msg } of events) {
    if (!msg || typeof msg !== "object") continue;
    seen(from, msg, t);
    const anchor = msg.dyncap?.anchor ?? null;
    switch (msg.kind) {
      case "poll-open":
        polls.set(msg.id, { id: msg.id, question: msg.question, method: msg.method, options: (msg.options || []).map((o) => ({ ...o })),
          creator: msg.creator ?? from, creatorLabel: msg.creatorLabel, createdAt: msg.createdAt, openedT: t, ballots: [], lockedT: null, closedT: null });
        break;
      case "poll-option": { const p = polls.get(msg.pollId); if (p) p.options.push({ id: msg.id, text: msg.text, by: msg.by, at: msg.at, t }); break; }
      case "poll-ballot": { const p = polls.get(msg.pollId); if (p) p.ballots.push({ peer: from, anchor, choices: msg.choices || [], t }); break; }
      case "poll-lock": { const p = polls.get(msg.pollId); if (p) p.lockedT = t; break; }
      case "poll-close": { const p = polls.get(msg.pollId); if (p) p.closedT = t; break; }
      case "estimate-open":
        estimates.set(msg.id, { id: msg.id, question: msg.question, tally: msg.tally, creator: from, openedT: t, values: [], closedT: null });
        break;
      case "estimate-value": { const e = estimates.get(msg.id); if (e) e.values.push({ peer: from, anchor, value: msg.value, t }); break; }
      case "estimate-close": { const e = estimates.get(msg.id); if (e) e.closedT = t; break; }
      case "lemma":
        lemmas.push({ name: msg.name, twists: msg.twists, who: msg.who, text: msg.text ?? null, peer: from, anchor, t });
        break;
      case "retract":
        retracted.push({ what: msg.what, id: msg.id, peer: from, t });
        break;
      case "chat":
        if (typeof msg.text === "string") chat.push({ t, peer: from, name: nameOf(from), text: msg.text.slice(0, 2000) });
        break;
      case "qlf":
        qlf.push({ t, peer: from, cmd: msg.cmd, arg: msg.arg ?? null });
        break;
      default:
        break;
    }
  }
  // Finalize polls: latest ballot per peer counts (as in the browser), both tallies.
  const pollRecords = [...polls.values()].map((p) => {
    const latest = {};
    for (const b of p.ballots) latest[b.peer] = b.choices;
    const raw = p.method === "ranked" ? tallyRanked(p.options, latest) : tallyApproval(p.options, latest);
    const weighted = weights ? (p.method === "ranked" ? tallyRanked(p.options, latest, weights) : tallyApproval(p.options, latest, weights)) : null;
    const optText = (id) => p.options.find((o) => o.id === id)?.text ?? id;
    return { ...p, finalBallots: latest, tally: { raw, weighted, weights: weights ? Object.fromEntries(Object.keys(latest).map((k) => [k, weights[k] ?? 1])) : null,
      winners: raw.winners.map(optText), winnersWeighted: weighted ? weighted.winners.map(optText) : null } };
  });
  const estimateRecords = [...estimates.values()].map((e) => {
    const latest = {};
    for (const v of e.values) latest[v.peer] = v.value;
    const vals = Object.values(latest).filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
    const n = vals.length;
    const median = n ? (n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2) : null;
    const mean = n ? vals.reduce((s, x) => s + x, 0) / n : null;
    return { ...e, finalValues: latest, summary: { n, median, mean, min: n ? vals[0] : null, max: n ? vals[n - 1] : null } };
  });
  return {
    schema: GAME_SCHEMA,
    ...header,
    events: events.length,
    eventRange: events.length ? { first: events[0].t, last: events[events.length - 1].t } : null,
    participants,
    polls: pollRecords,
    estimates: estimateRecords,
    lemmas,
    retracted,
    chat,
    qlf,
  };
}

/** The recorder an agent holds: start / record / stop. */
export function createGameRecorder({ stateDir, roomHex, observer, nameOf, weightsProvider = () => null, log = console.log }) {
  const dir = path.join(stateDir, "rooms", roomHex, "games");
  const indexPath = path.join(stateDir, "rooms", roomHex, "games.json");
  let cur = null;
  const writeJSON = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); const tmp = p + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(v, null, 2)); fs.renameSync(tmp, p); };
  return {
    get current() { return cur; },
    start(rawSpec, startedBy) {
      if (cur) return { ok: false, reason: `already recording "${cur.spec.label}"` };
      const spec = parseSpec(rawSpec);
      const ts = Date.now();
      const base = `${ts}-${slugify(spec.label)}`;
      fs.mkdirSync(dir, { recursive: true });
      cur = { spec, startedAt: new Date(ts).toISOString(), startedBy, base,
        eventsPath: path.join(dir, `${base}.events.jsonl`), recordPath: path.join(dir, `${base}.json`), summaryPath: path.join(dir, `${base}.summary.md`), count: 0 };
      fs.writeFileSync(cur.eventsPath, "");
      log(`game: recording "${spec.label}" → ${cur.eventsPath}`);
      return { ok: true, game: cur };
    },
    record(from, msg) {
      if (!cur) return;
      try { fs.appendFileSync(cur.eventsPath, JSON.stringify({ t: new Date().toISOString(), from, msg }) + "\n"); cur.count++; } catch (e) { log(`game: event write failed: ${e?.message ?? e}`); }
    },
    stop() {
      if (!cur) return { ok: false, reason: "not recording" };
      const g = cur; cur = null;
      const header = { label: g.spec.label, slug: slugify(g.spec.label), room: roomHex, observer, startedAt: g.startedAt, stoppedAt: new Date().toISOString(),
        startedBy: g.startedBy, spec: g.spec, eventsFile: path.basename(g.eventsPath) };
      const record = materialize(g.eventsPath, header, { nameOf, weights: weightsProvider() });
      writeJSON(g.recordPath, record);
      let idx = [];
      try { idx = JSON.parse(fs.readFileSync(indexPath, "utf8")); } catch {}
      idx.push({ label: header.label, startedAt: header.startedAt, stoppedAt: header.stoppedAt, file: `games/${path.basename(g.recordPath)}`, events: record.events, polls: record.polls.length, estimates: record.estimates.length, lemmas: record.lemmas.length });
      writeJSON(indexPath, idx);
      log(`game: recorded "${header.label}" → ${g.recordPath} (${record.events} events, ${record.polls.length} polls, ${record.estimates.length} estimates, ${record.lemmas.length} lemmas)`);
      return { ok: true, game: g, record };
    },
    list() { try { return JSON.parse(fs.readFileSync(indexPath, "utf8")); } catch { return []; } },
    loadLatest() {
      const idx = this.list();
      if (!idx.length) return null;
      const last = idx[idx.length - 1];
      try { return { entry: last, record: JSON.parse(fs.readFileSync(path.join(stateDir, "rooms", roomHex, last.file), "utf8")) }; } catch { return null; }
    },
    writeSummary(record, text) {
      const p = path.join(dir, `${path.basename(record.eventsFile, ".events.jsonl")}.summary.md`);
      const head = `# ${record.label}\n\nRoom ${record.room} · observer ${record.observer?.name ?? ""} (${record.observer?.peerId ?? ""})\n` +
        `Recorded ${record.startedAt} → ${record.stoppedAt}; ${record.events} events` +
        (record.eventRange ? ` (${record.eventRange.first} … ${record.eventRange.last})` : "") + `; record: ${path.basename(record.eventsFile, ".events.jsonl")}.json\n` +
        (record.spec?.payoffs ? `Payoffs (a,b,c,d) = (${record.spec.payoffs.a}, ${record.spec.payoffs.b}, ${record.spec.payoffs.c}, ${record.spec.payoffs.d})\n` : "") +
        (record.spec?.predictions?.length ? `Pre-registered: ${record.spec.predictions.map((p, i) => `(${i + 1}) ${p}`).join("; ")}\n` : "") + "\n";
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, head + text.trim() + "\n");
      return p;
    },
  };
}

/** A compact rendering of a game record for the AI summary prompt (bounded size). */
export function compactForPrompt(record, maxChars = 9000) {
  const name = (p) => record.participants?.[p]?.name ?? p.slice(0, 8);
  const out = [];
  out.push(`GAME: ${record.label}`);
  out.push(`Spec (verbatim start command): ${record.spec?.raw ?? ""}`);
  if (record.spec?.payoffs) out.push(`Payoffs a=u(S|S)=${record.spec.payoffs.a} b=u(S|H)=${record.spec.payoffs.b} c=u(H|S)=${record.spec.payoffs.c} d=u(H|H)=${record.spec.payoffs.d}`);
  if (record.spec?.predictions?.length) out.push(`Pre-registered predictions: ${record.spec.predictions.map((p, i) => `(${i + 1}) ${p}`).join(" ")}`);
  out.push(`Participants: ${Object.entries(record.participants || {}).map(([p, v]) => `${v.name}${v.anchor ? "" : " (unsigned)"}`).join(", ")}`);
  for (const p of record.polls || []) {
    out.push(`POLL ${p.id} [${p.method}] "${p.question}" opened ${p.openedT}${p.closedT ? ` closed ${p.closedT}` : " (never closed)"}`);
    out.push(`  options: ${p.options.map((o) => `${o.id}="${o.text}"`).join("; ")}`);
    for (const b of p.ballots) out.push(`  ballot ${b.t} ${name(b.peer)}: ${b.choices.join(",")}`);
    out.push(`  raw tally: ${JSON.stringify(p.tally.raw.counts ?? p.tally.raw.rounds)} winners: ${p.tally.winners.join(" | ")}` + (p.tally.weighted ? `; trust-weighted winners: ${p.tally.winnersWeighted.join(" | ")}` : ""));
  }
  for (const e of record.estimates || []) {
    out.push(`ESTIMATE ${e.id} "${e.question}" (${e.tally}) opened ${e.openedT}${e.closedT ? ` closed ${e.closedT}` : ""}: ` + e.values.map((v) => `${name(v.peer)}=${v.value}`).join(", ") + ` → median ${e.summary.median} mean ${e.summary.mean}`);
  }
  for (const l of record.lemmas || []) out.push(`LEMMA ${l.t} ${name(l.peer)}: ${l.name}${l.text ? ` — ${l.text}` : ""}`);
  for (const q of record.qlf || []) out.push(`QLF ${q.t} ${name(q.peer)}: /${q.cmd} ${q.arg ?? ""}`);
  out.push("CHAT:");
  for (const c of record.chat || []) out.push(`  ${c.t.slice(11, 19)} ${c.name}: ${c.text.slice(0, 300)}`);
  let text = out.join("\n");
  if (text.length > maxChars) text = text.slice(0, maxChars) + "\n…(truncated)";
  return text;
}

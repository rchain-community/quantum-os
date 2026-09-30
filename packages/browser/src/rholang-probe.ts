/// Pure tier-2 cross-checking for rnode room members (#138).
///
/// The transport/authentication layer is deliberately outside this module:
/// callers only pass attestations after the room has accepted the envelope
/// identity (for example through dyncap). This function answers a narrower
/// question: given distinct peer perspectives, did deterministic rholang
/// execution agree for the same program and pre-state?
///
/// A single rnode never becomes proof. Different programs or pre-states are
/// not comparable and therefore stay INCONCLUSIVE. Only same-input divergence
/// is a decidable falsifier.

export interface RnodeAttestation {
  peer: string;
  program: string;
  preStateHash: string;
  postStateHash: string;
  result: string;
}

export type RholangProbeStatus = "AGREEMENT" | "FALSIFIED" | "INCONCLUSIVE";

export interface ValueBucket {
  value: string;
  peers: string[];
}

export interface RholangFalsifier {
  kind: "peer-equivocation" | "post-state-divergence" | "result-divergence";
  peer?: string;
  observations?: RnodeAttestation[];
  values?: ValueBucket[];
}

export interface RholangProbeAssessment {
  status: RholangProbeStatus;
  perspectives: number;
  peers: string[];
  program: string | null;
  preStateHash: string | null;
  postStateHash?: string;
  result?: string;
  blockers: string[];
  falsifiers: RholangFalsifier[];
}

function complete(a: RnodeAttestation): boolean {
  return [a.peer, a.program, a.preStateHash, a.postStateHash]
    .every((v) => typeof v === "string" && v.length > 0)
    && typeof a.result === "string";
}

function sameAttestation(a: RnodeAttestation, b: RnodeAttestation): boolean {
  return a.peer === b.peer
    && a.program === b.program
    && a.preStateHash === b.preStateHash
    && a.postStateHash === b.postStateHash
    && a.result === b.result;
}

function buckets(rows: RnodeAttestation[], pick: (a: RnodeAttestation) => string): ValueBucket[] {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const value = pick(row);
    const peers = grouped.get(value) ?? [];
    if (!peers.includes(row.peer)) peers.push(row.peer);
    grouped.set(value, peers);
  }
  return [...grouped.entries()].map(([value, peers]) => ({ value, peers }));
}

export function assessRnodeAttestations(
  input: RnodeAttestation[],
  minPerspectives = 2,
): RholangProbeAssessment {
  const blockers: string[] = [];
  const falsifiers: RholangFalsifier[] = [];

  if (!Number.isInteger(minPerspectives) || minPerspectives < 2) {
    blockers.push("minPerspectives must be an integer >= 2");
    minPerspectives = 2;
  }

  const malformed = input.filter((a) => !complete(a));
  if (malformed.length > 0) {
    blockers.push(`${malformed.length} malformed attestation(s) omitted`);
  }

  const rows: RnodeAttestation[] = [];
  for (const a of input.filter(complete)) {
    if (!rows.some((existing) => sameAttestation(existing, a))) rows.push(a);
  }

  const peers = [...new Set(rows.map((a) => a.peer))];
  const programs = [...new Set(rows.map((a) => a.program))];
  const preStates = [...new Set(rows.map((a) => a.preStateHash))];

  if (programs.length > 1) {
    blockers.push("attestations do not describe the same program");
  }
  if (preStates.length > 1) {
    blockers.push("attestations do not share the same pre-state");
  }

  if (blockers.length > 0) {
    return {
      status: "INCONCLUSIVE",
      perspectives: peers.length,
      peers,
      program: programs.length === 1 ? programs[0] : null,
      preStateHash: preStates.length === 1 ? preStates[0] : null,
      blockers,
      falsifiers,
    };
  }

  const byPeer = new Map<string, RnodeAttestation[]>();
  for (const a of rows) {
    const peerRows = byPeer.get(a.peer) ?? [];
    peerRows.push(a);
    byPeer.set(a.peer, peerRows);
  }

  for (const [peer, peerRows] of byPeer) {
    if (peerRows.length > 1) {
      falsifiers.push({ kind: "peer-equivocation", peer, observations: peerRows });
    }
  }

  if (falsifiers.length > 0) {
    return {
      status: "FALSIFIED",
      perspectives: peers.length,
      peers,
      program: programs[0] ?? null,
      preStateHash: preStates[0] ?? null,
      blockers,
      falsifiers,
    };
  }

  if (peers.length < minPerspectives) {
    blockers.push(
      `need at least ${minPerspectives} distinct rnode perspectives; got ${peers.length}`,
    );
    return {
      status: "INCONCLUSIVE",
      perspectives: peers.length,
      peers,
      program: programs[0] ?? null,
      preStateHash: preStates[0] ?? null,
      blockers,
      falsifiers,
    };
  }

  const onePerPeer = [...byPeer.values()].map((peerRows) => peerRows[0]);
  const postStates = buckets(onePerPeer, (a) => a.postStateHash);
  const results = buckets(onePerPeer, (a) => a.result);

  if (postStates.length > 1) {
    falsifiers.push({ kind: "post-state-divergence", values: postStates });
  }
  if (results.length > 1) {
    falsifiers.push({ kind: "result-divergence", values: results });
  }

  if (falsifiers.length > 0) {
    return {
      status: "FALSIFIED",
      perspectives: rows.length,
      peers,
      program: programs[0],
      preStateHash: preStates[0],
      blockers,
      falsifiers,
    };
  }

  return {
    status: "AGREEMENT",
    perspectives: rows.length,
    peers,
    program: programs[0],
    preStateHash: preStates[0],
    postStateHash: postStates[0].value,
    result: results[0].value,
    blockers,
    falsifiers,
  };
}

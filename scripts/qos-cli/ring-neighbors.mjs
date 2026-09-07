// Ring + skip-link neighbor computation for the bounded-degree connection
// overlay — a pure, zero-dependency mirror of packages/browser/src/peer.ts's
// own ringSkipNeighbors (that file is the source of truth; duplicated here,
// not imported, since a browser TypeScript module needs a bundler and this
// directory is deliberately plain, dependency-free node ESM).
//
// Split into its own tiny module (rather than living inline in qospeer.mjs,
// which is what actually calls it at runtime) so selftest.mjs — explicitly
// dependency-free, no network, no werift — can test the pure ring math
// without pulling in qospeer.mjs's "ws"/"werift" imports just to get at it.
//
// Sort everyone present lexicographically and connect to the peers one and
// two positions away in each direction (degree 4), which degenerates to
// full mesh automatically for five or fewer peers and caps degree at 4 past
// that, regardless of room size. A pure function of the roster, so every
// peer computes the same neighbor sets independently — no coordination
// message needed — and the relation is symmetric by construction.
export function ringSkipNeighbors(sortedIds, myId) {
  const n = sortedIds.length;
  const i = sortedIds.indexOf(myId);
  const out = new Set();
  if (i === -1 || n <= 1) return out;
  for (const off of [1, -1, 2, -2]) {
    const j = ((i + off) % n + n) % n;
    if (j !== i) out.add(sortedIds[j]);
  }
  return out;
}

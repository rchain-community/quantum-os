// Dependency-free self-test of the ZFA capability layer (no network, no werift).
// Verifies generated peer tokens are valid ZFA caps and that validation matches
// the documented rules. Run: node selftest.mjs
import { generateCapability, validateCapability, achievesZfa, parseTwists } from "./zfa.mjs";
import { ringSkipNeighbors } from "./ring-neighbors.mjs";

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) fail++; };

// 1. Generated peer caps are valid and Pauli-closed + count-balanced.
for (let i = 0; i < 200; i++) {
  const cap = generateCapability("peer");
  if (!cap.startsWith("cap:peer:") || !validateCapability(cap)) {
    ok(false, `generated cap invalid: ${cap}`); break;
  }
}
ok(fail === 0, "200 generated peer caps all validate (count-balanced ∧ Pauli-closed)");

// 2. Malformed tokens rejected.
ok(!validateCapability("cap:peer:"), "empty hex rejected");
ok(!validateCapability("notacap:peer:0246"), "non-cap prefix rejected");
ok(!validateCapability("cap:peer:0289"), "hex digits >7 rejected");
ok(!validateCapability("cap:peer:06"), "count-imbalanced (0,6 both pos) rejected");

// 3. Known closure facts (mirror twist_core / pauli.rs).
//    "+-" = Plus,Minus = +I · -I = -I  → Pauli-closed; count-balanced (6 pos, 7 neg).
ok(achievesZfa(Uint8Array.from([6, 7])), "'+-' (6,7) is ZFA (closes to -I, balanced)");
//    "^v" = Up,Down = +σ_y · -σ_y = +I → Pauli-closed; balanced (0 pos, 1 neg).
ok(achievesZfa(Uint8Array.from([0, 1])), "'^v' (0,1) is ZFA (closes to +I, balanced)");
//    count-balanced but NOT pauli-closed: ^ < v -  (0,3,1,7) folds to a σ.
ok(!achievesZfa(Uint8Array.from([0, 3, 1, 7])), "'^<v-' balanced but not Pauli-closed → not ZFA");

// 4. parseTwists — symbolic, hex, and cap forms all yield the same sequence.
const A = parseTwists("^v");        // symbolic → [0,1]
const B = parseTwists("01");        // hex      → [0,1]
ok(A && B && A.join() === "0,1" && B.join() === "0,1", "parseTwists symbolic '^v' == hex '01' == [0,1]");
ok(parseTwists("cap:lemma:0167")?.join() === "0,1,6,7", "parseTwists extracts hex from cap:lemma:0167");
ok(parseTwists("zzz") === null, "parseTwists rejects invalid symbols");
ok(achievesZfa(parseTwists("+-")), "parseTwists('+-') is ZFA");

// 5. The published public-room cap (informational — peer.ts only warns if invalid).
const ROOM = "cap:room:05214747236101414325074505234721";
console.log(`\nPublished room cap validates as ZFA: ${validateCapability(ROOM)}`);

// 6. Ring+skip overlay topology (mirrors packages/browser/src/peer.ts's
//    ringSkipNeighbors, via the zero-dependency ring-neighbors.mjs).
for (let n = 1; n <= 5; n++) {
  const ids = Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));   // already sorted: a, b, c, ...
  const allFullMesh = ids.every((id) => ringSkipNeighbors(ids, id).size === n - 1);
  ok(allFullMesh, `ring: n=${n} degenerates to full mesh (every peer within ±2)`);
}
const six = ["a", "b", "c", "d", "e", "f"];
const nbA = ringSkipNeighbors(six, "a");
ok(nbA.size === 4, "ring: n=6 caps degree at 4, not full mesh (n-1=5)");
ok(!nbA.has("d"), "ring: n=6 excludes the antipodal peer");
const ten = Array.from({ length: 10 }, (_, i) => `p${i}`);   // p0..p9, still lexicographically sorted
let allDegree4 = true, allSymmetric = true;
for (const id of ten) {
  const nb = ringSkipNeighbors(ten, id);
  if (nb.size !== 4) allDegree4 = false;
  for (const other of nb) if (!ringSkipNeighbors(ten, other).has(id)) allSymmetric = false;
}
ok(allDegree4, "ring: n=10 gives every peer degree exactly 4");
ok(allSymmetric, "ring: n=10 neighbor relation is symmetric — no coordination message needed");
ok(ringSkipNeighbors(["solo"], "solo").size === 0, "ring: a lone peer has no neighbors");

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
process.exit(fail === 0 ? 0 : 1);

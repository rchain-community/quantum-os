// Dependency-free self-test of the ZFA capability layer (no network, no werift).
// Verifies generated peer tokens are valid ZFA caps and that validation matches
// the documented rules. Run: node selftest.mjs
import { generateCapability, validateCapability, achievesZfa, parseTwists } from "./zfa.mjs";

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

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
process.exit(fail === 0 ? 0 : 1);

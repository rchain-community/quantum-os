// gov-docs.test.mjs — a /gov subcommand that nobody can find is a /gov
// subcommand that does not exist.
//
// This exists because it happened twice. `/gov claim` shipped documented
// nowhere — and it is the recovery path for somebody locked out of a group they
// created, so it is precisely the thing they need to find at the worst moment.
// `/gov chain` shipped without reaching the room agent's own knowledge, so
// `/facil ask` — which CLAUDE.md calls "an expert on QuantumOS itself" — said it
// had never heard of it. Both were caught by a person, not by CI.
//
// So: every subcommand the dispatcher answers must be findable in
// Governance.md, and the governance commands a person is likely to ASK about
// must be in the advisor's knowledge. Neither check is clever; both are the kind
// a human reviewer skips.
//
//   node packages/browser/test/gov-docs.test.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const app = readFileSync(join(root, "packages/browser/src/app.ts"), "utf8");
const governance = readFileSync(join(root, "Governance.md"), "utf8");
const advisor = readFileSync(join(root, "scripts/qos-cli/facilitator-advisor.mjs"), "utf8");

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
};

// Every `gsub === "x"` the /gov dispatcher tests for.
const subs = [...new Set([...app.matchAll(/gsub === "([a-z]+)"/g)].map((m) => m[1]))].sort();
ok("found the /gov subcommands in app.ts", subs.length > 10, `found ${subs.length}`);

// A few are structural rather than user-facing verbs.
const structural = new Set(["list"]);
for (const sub of subs) {
  if (structural.has(sub)) continue;
  ok(`Governance.md documents /gov ${sub}`,
     governance.includes(`/gov ${sub}`),
     "a command nobody can find is one that does not exist");
}

// The advisor answers "how do I …". CLAUDE.md: keep askKnowledge in sync when
// adding commands. These are the ones a person asks about by name.
for (const phrase of ["/gov chain", "/gov chain install", "/gov chain push", "/gov chain pull", "/gov claim"]) {
  ok(`the room agent knows ${phrase}`, advisor.includes(phrase),
     "/facil ask is meant to name the exact command");
}

// The chain commands need a key, and saying so is most of the answer.
ok("the agent says the chain path needs a deploy key",
   /rholang key generate/.test(advisor));
// …and that it is optional, so nobody thinks a room needs a chain.
ok("the agent says a chain is optional",
   /Nothing else in\s*\n?\s*quantum-os needs a chain|additive/.test(advisor));

console.log(`\ngov-docs: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

// exchange-2pc.test.mjs — the cross-shard trade recovery decision table
// (exchange-2pc.ts). Pure, dependency-free — bundles and imports cleanly.
//
//   node packages/browser/test/exchange-2pc.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "exchange-2pc.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
});
const { decideRecovery, evaluateTrade, makeTxId } =
  await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (${detail})`); }
};

const rec = (local, remote, expect) => {
  const got = decideRecovery(local, remote);
  check(`decideRecovery(${local}, ${remote}) → ${expect}`, got === expect, `got ${got}`);
};

// The happy path.
rec("prepared", "prepared", "commit-both");

// The local leg prepared, but the remote leg never did (a rejected
// prepareReceive, or the client crashed before ever calling it) — unwind.
rec("prepared", "unknown", "abort-local");
rec("prepared", "aborted", "abort-local");

// The remote leg is already settled ahead of the local one — finish
// whichever side is behind, never re-decide a terminal state.
rec("prepared", "committed", "commit-local");
rec("committed", "prepared", "commit-remote");
rec("aborted", "prepared", "abort-remote");

// Fully settled — nothing to do.
rec("committed", "committed", "noop");
rec("aborted", "aborted", "noop");
rec("aborted", "unknown", "noop");
rec("unknown", "prepared", "noop"); // no local tx to recover, regardless of remote

// A client that committed local before confirming remote prepared (a
// misuse the protocol's own call order prevents, but the contract itself
// does not check) — flagged, not silently resolved either way.
rec("committed", "unknown", "inconsistent");
rec("committed", "aborted", "inconsistent");
rec("aborted", "committed", "inconsistent");

// evaluateTrade folds the pair into one outcome with a settled flag.
{
  const o = evaluateTrade("tx1", "prepared", "prepared");
  check("evaluateTrade: commit-both is not settled (still work to do)",
    o.action === "commit-both" && o.settled === false, JSON.stringify(o));
}
{
  const o = evaluateTrade("tx1", "committed", "committed");
  check("evaluateTrade: noop is settled", o.action === "noop" && o.settled === true, JSON.stringify(o));
}
{
  const o = evaluateTrade("tx1", "committed", "aborted");
  check("evaluateTrade: inconsistent is settled (nothing more this module can decide)",
    o.action === "inconsistent" && o.settled === true, JSON.stringify(o));
}

// makeTxId — opaque, non-empty, and doesn't collide across a modest sample.
{
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(makeTxId());
  check("makeTxId: 1000 draws, no collisions, all non-empty hex",
    ids.size === 1000 && [...ids].every((id) => /^[0-9a-f]{32}$/.test(id)));
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: exchange-2pc.test.mjs (${failed} failure${failed === 1 ? "" : "s"})`);
process.exit(failed === 0 ? 0 : 1);

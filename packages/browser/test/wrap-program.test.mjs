// wrap-program.test.mjs — wrapProgram merges into a program's own `new`
// rather than nesting a second `new return, stdout, … in { … }` layer.
//
//   node packages/browser/test/wrap-program.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "rholang.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
});
const { wrapProgram, splitTopNew } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

let fail = 0;
const ok = (c, m, d = "") => { console.log(`  ${c ? "ok  " : "FAIL"} ${m}${c ? "" : "  — " + d}`); if (!c) fail++; };
const countNew = (s) => (s.match(/\bnew\b/g) ?? []).length;

// --- splitTopNew ---
ok(splitTopNew("new x, y in { x!(1) }")?.decls === "x, y", "splitTopNew: decls");
ok(splitTopNew("new x in { x!(1) }")?.inner.trim() === "x!(1)", "splitTopNew: inner");
ok(splitTopNew("  // note\n  new a(`u`), b in {\n  a!(*b)\n}\n")?.decls === "a(`u`), b",
   "splitTopNew: leading comment + backtick urn");
ok(splitTopNew('new x in { x!("has } brace and new in string") }') !== null,
   "splitTopNew: braces/keywords inside a string do not fool it");
ok(splitTopNew("new x in { x!(1) } | y!(2)") === null,
   "splitTopNew: trailing code after the block ⟹ null");
ok(splitTopNew("x!(1)") === null, "splitTopNew: not a `new` at all ⟹ null");
ok(splitTopNew("new x in { new y in { y!(1) } }")?.inner.includes("new y in") === true,
   "splitTopNew: a nested inner `new` is left in the inner");

// --- wrapProgram: a $macro-style body (one `new … in { … }`) merges ---
const macroBody = `new revVault(\`rho:rchain:revVault\`), ret in {
  revVault!("getBalance", "1111abc", *ret) |
  for (@bal <- ret) { return!(bal) }
}`;
const evalW = wrapProgram(macroBody, "eval");
ok(countNew(evalW) === 1, "eval: merged — exactly one `new`, not a nested pair", evalW);
ok(evalW.includes("return,") && evalW.includes("revVault(`rho:rchain:revVault`), ret in {"),
   "eval: our `return` + the body's own decls are in the one `new`");
ok(evalW.includes('revVault!("getBalance", "1111abc", *ret)'), "eval: the body is intact");

const deployW = wrapProgram(macroBody, "deploy", 5);
ok(countNew(deployW) === 1, "deploy: also merged — one `new`", deployW);
ok(deployW.includes("for (@__value <- return) {") && deployW.includes("__insertSigned!((5, __value)"),
   "deploy: the record forwarder is appended at top level");

// --- dedupe: the body already binds a powerbox name we would add ---
const withStdout = `new stdout(\`rho:io:stdout\`), x in { stdout!(*x) }`;
const dw = wrapProgram(withStdout, "eval");
ok((dw.match(/\bstdout\(/g) ?? []).length === 1, "dedupe: `stdout` bound once, not twice", dw);
ok(dw.includes("return,"), "dedupe: `return` still added");

// --- a non-`new` body still gets the classic nested wrapper ---
const plain = wrapProgram('return!(41 + 1)', "eval");
ok(countNew(plain) === 1 && plain.includes("in {\n  return!(41 + 1)\n}"),
   "plain body: wrapped as before", plain);

// --- a body with trailing code after its `new` block: classic wrap (can't merge) ---
const partial = wrapProgram('new g(`rho:qucalc:grant`), r in { g!([0,1], *r) } | stdout!("done")', "eval");
ok(countNew(partial) === 2, "partial (trailing code): falls back to nesting", partial);

console.log(fail === 0 ? "\nwrap-program: all passed" : `\nwrap-program: ${fail} FAILED`);
process.exit(fail ? 1 : 0);

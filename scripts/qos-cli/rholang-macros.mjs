// rholang-macros.mjs — the agent's binding of the shared macro engine.
//
// The registry, argument validators, templates and rholang scanner all live in
// packages/browser/src/rholang-macros.js, which the browser imports too. This
// file only supplies the node-side ZFA kernel and re-exports the result, so a
// macro can never differ between what the agent posts in chat and what the
// browser lints and signs.

import { achievesZfa, isPauliClosed, parseTwists, validateCapability } from "./zfa.mjs";
import { createMacroEngine } from "../../packages/browser/src/rholang-macros.js";

export const { MACROS, macroMode, expandBare, expandProgram, expandMacro, listMacros, HELP, selftest } =
  createMacroEngine({ achievesZfa, isPauliClosed, parseTwists, validateCapability });

// Run selftest when invoked directly with --selftest.
if (typeof process !== "undefined" && process.argv.includes("--selftest")) {
  process.exit(selftest() ? 0 : 1);
}

// macro-lang.js — Interact2: the parser and expander behind `+commands`.
//
// EIES let a user write a command, share it, and watch a group adopt it. That
// was the point of the system rather than a feature of it (EIES_Legacy.md).
// This module is the mechanism: a definition is text with `$` sites, expansion
// is textual, and what the expansion is *for* depends on where it was invoked.
//
// SINGLE SOURCE OF TRUTH, on the same argument as rholang-macros.js: the agent
// will want to expand a macro to show a room what a `+command` does, and the
// browser expands the one it actually runs. Those must not be able to differ.
// Plain JS with no imports so both toolchains consume it directly — node runs
// it as-is (packages/browser is `"type": "module"`), Vite bundles it.
//
//   node packages/browser/src/macro-lang.js --selftest
//
// Two kinds of macro fall out of the body, and the distinction is not invented
// here — it is which of the two halves the body is written in:
//
//   command   the body's first line starts with `/` or `+`, so the body is a
//             sequence of QuantumOS commands. Invoked as `+name args`. This is
//             the EIES half — a command that composes the room's own
//             capabilities: /lemma, /poll, /note, /gov, /rholang.
//   rholang   the body is rholang. It has no meaning as a command, so it is
//             invoked as a `$name(…)` call site inside another program, the
//             way MacRhoLang's `$print($expression)` was. This is the @RHO-bot
//             half.
//
// The `$` sigil is what makes a scanner safe without a rholang grammar: `$` is
// lexically illegal in rholang (the node's lexer says `Illegal character $`),
// so a `$` site can never be valid rholang, an unexpanded one cannot silently
// become something else, and the node is the backstop if expansion is missed.
// The `%` sigil this replaces is rholang's modulo operator, so its call sites
// shared a character with arithmetic.

/**
 * @typedef {object} MacroDef
 * @property {string}   name        canonical (lowercased) macro name
 * @property {string[]} params      parameter names, without the `$`
 * @property {string}   body        raw body text, `$param` sites unsubstituted
 * @property {string}   doc         the comment that followed the name, if any
 * @property {"command"|"rholang"} kind
 * @property {string}   author      peerId of the definer
 * @property {string}   authorLabel display name at definition time
 * @property {number}   at          definition timestamp (ms)
 */

/** A macro name: same shape as a rholang identifier, so it can be read aloud. */
export const MACRO_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** How deep `$name(…)` sites may nest before expansion gives up. */
export const MAX_DEPTH = 8;

/** Longest body we will store, so one definition cannot fill a room's state. */
export const MAX_BODY = 8000;

export class MacroError extends Error {
  constructor(message) { super(message); this.name = "MacroError"; }
}
const fail = (msg) => { throw new MacroError(msg); };

// ---------------------------------------------------------------------------
// Scanner
//
// Lifted deliberately from rholang-macros.js rather than reinvented: it is the
// part that has been exercised against real rholang. It never parses — it
// skips string literals and both comment forms, balances brackets, and splits
// on top-level commas. Everything else passes through as written.
// ---------------------------------------------------------------------------

/** Advance past a rholang string literal starting at `i` (src[i] === '"'). */
function skipString(src, i) {
  i++;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === '"') return i + 1;
    i++;
  }
  return -1;                       // unterminated
}

/** Advance past whichever of string / line comment / block comment starts at `i`, else -1. */
function skipTrivia(src, i) {
  if (src[i] === '"') return skipString(src, i);
  if (src[i] === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); return e < 0 ? src.length : e; }
  if (src[i] === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); return e < 0 ? -1 : e + 2; }
  return -1;
}

const CLOSERS = { "(": ")", "[": "]", "{": "}" };

/** Index of the bracket closing the one at `open`, or -1 if unbalanced. */
function matchBracket(src, open) {
  const stack = [CLOSERS[src[open]]];
  let i = open + 1;
  while (i < src.length) {
    const t = skipTrivia(src, i);
    if (t === -1 && (src[i] === '"' || (src[i] === "/" && src[i + 1] === "*"))) return -1;
    if (t !== -1) { i = t; continue; }
    const c = src[i];
    if (CLOSERS[c]) stack.push(CLOSERS[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack[stack.length - 1] !== c) return -1;
      stack.pop();
      if (!stack.length) return i;
    }
    i++;
  }
  return -1;
}

/** Split an argument list on top-level commas. */
export function splitArgs(src) {
  const out = [];
  let depth = 0, start = 0, i = 0;
  while (i < src.length) {
    const t = skipTrivia(src, i);
    if (t !== -1) { i = t; continue; }
    const c = src[i];
    if (CLOSERS[c]) depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { out.push(src.slice(start, i)); start = i + 1; }
    i++;
  }
  const tail = src.slice(start);
  if (out.length || tail.trim()) out.push(tail);
  return out.map((x) => x.trim()).filter((x, n, a) => !(a.length === 1 && x === ""));
}

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/**
 * Parse a definition: `name text`, or `name(a, b) text`.
 *
 *   /macro define greet(who) Hi $who, welcome!
 *   /macro define standup(topic)
 *   /poll new $topic | yes, no, later
 *
 * The name is bare — a leading `$` or `+` is tolerated but not required. The
 * parameter list is optional (a value macro has none — `$Ballot`, `$lookup` in
 * MacRhoLang), its names bare. The body is everything after the signature: on
 * the same line, or on the lines below it. `$param` sites in the body are still
 * written `$name` — that is what the expander substitutes.
 *
 * A `// comment` immediately after the signature is the macro's doc, kept for
 * `show` and for an LLM composing a program. (An inline body that must itself
 * start with `//` is the one case that needs the body on the next line.)
 *
 * @param {string} text
 * @returns {{name:string, params:string[], body:string, doc:string, kind:"command"|"rholang"}}
 */
export function parseDefinition(text) {
  const src = String(text ?? "");
  const m = /^\s*[$+]?([A-Za-z][A-Za-z0-9_-]*)/.exec(src);
  if (!m) fail("a definition is: /macro define name[(args)] body — e.g. /macro define standup(topic) /poll new $topic | yes, no");
  const name = m[1].toLowerCase();
  let i = m[0].length;

  /** @type {string[]} */
  let params = [];
  // Only an immediately adjacent `(` opens a parameter list — `greet (x)` reads
  // as a value macro whose body starts `(x)`.
  if (src[i] === "(") {
    const close = matchBracket(src, i);
    if (close === -1) fail(`${name}: unbalanced ( in the parameter list`);
    params = splitArgs(src.slice(i + 1, close)).map((p) => {
      const pm = /^[$]?([A-Za-z][A-Za-z0-9_-]*)$/.exec(p.trim());
      if (!pm) fail(`${name}: parameter "${p.trim()}" must be a plain name`);
      return pm[1];
    });
    const dup = params.find((p, n) => params.indexOf(p) !== n);
    if (dup) fail(`${name}: parameter ${dup} is named twice`);
    i = close + 1;
  }

  // The rest of the signature line: an optional `// doc`, otherwise the body has
  // already started (the inline form).
  const nl = src.indexOf("\n", i);
  const restOfLine = src.slice(i, nl === -1 ? src.length : nl);
  let doc = "";
  const dm = /^[^\S\n]*\/\/(.*)$/.exec(restOfLine);
  if (dm) { doc = dm[1].trim(); i += restOfLine.length; }

  // Body: everything after — trim a leading run of spaces and at most one
  // newline, so both `name(x) body` and `name(x)\nbody` land the same.
  const body = src.slice(i).replace(/^[^\S\n]*\n?/, "").replace(/\s+$/, "");
  if (!body.trim()) fail(`${name}: the definition has no body`);
  if (body.length > MAX_BODY) fail(`${name}: body is too long (${body.length} chars, max ${MAX_BODY})`);
  return { name, params, body, doc, kind: bodyKind(body) };
}

/** Which half of the language a body is written in — see the header. */
export function bodyKind(body) {
  const first = String(body ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return first.startsWith("/") || first.startsWith("+") ? "command" : "rholang";
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * Tokenize `+name arg "two words" key="two words"` the way a command line
 * reads. Quotes group but are NOT stripped here — whether they are part of the
 * value or just grouping depends on which side of the language the argument is
 * crossing into, and only `bindArgs` knows that.
 * @param {string} line
 * @returns {{name:string, args:string[]}}
 */
export function parseInvocation(line) {
  const src = String(line ?? "").trim().replace(/^\+/, "");
  const m = /^([A-Za-z][A-Za-z0-9_-]*)/.exec(src);
  if (!m) fail("an invocation is +name — e.g. +standup \"Q4 budget\"");
  return { name: m[1].toLowerCase(), args: tokenize(src.slice(m[1].length)) };
}

/**
 * Split on whitespace outside double quotes, keeping the quotes. A quoted run
 * is part of its token rather than a token of its own, so `key="two words"`
 * stays one argument.
 */
export function tokenize(s) {
  return String(s ?? "").match(/(?:[^\s"]|"(?:[^"\\]|\\.)*")+/g) ?? [];
}

/** Replace each quoted run in a token with its contents — the command-line reading. */
function unquote(s) {
  return String(s ?? "").trim().replace(/"((?:[^"\\]|\\.)*)"/g, (_, inner) => inner.replace(/\\(.)/g, "$1"));
}

/**
 * Bind call arguments to a definition's parameters.
 *
 * Positional by default, as rhobot does it for standard components; if EVERY
 * argument is written `name=value` they bind by name instead, which is the
 * form quantum-os#65 records (`$macroname(name="joe", age=5)`). Mixing the two
 * would make the reading of a call depend on where you stopped, so it is
 * refused.
 *
 * `plain` says which language the argument is crossing into, and it is the
 * whole difference between the two halves. A `+command` argument is a command
 * line word: `+standup "Q4 budget"` means the topic *is* `Q4 budget`, quotes
 * and all removed. A `$name(…)` call-site argument is a rholang **term** and
 * must arrive verbatim: `$print("hello")` has to expand to `stdout!("hello")`,
 * because dropping the quotes there would turn a string into a free variable.
 *
 * @param {MacroDef} def
 * @param {string[]} args
 * @param {boolean} [plain] true for a `+command` line, false for a rholang call site
 * @returns {Record<string,string>}
 */
export function bindArgs(def, args, plain = true) {
  const value = (v) => (plain ? unquote(v) : String(v).trim());
  const isNamed = (a) => /^[A-Za-z][A-Za-z0-9_-]*\s*=/.test(a);
  const named = args.length > 0 && args.every(isNamed);
  const mixed = !named && args.some(isNamed);
  /** @type {Record<string,string>} */
  const out = {};
  if (named) {
    for (const a of args) {
      const eq = a.indexOf("=");
      const k = a.slice(0, eq).trim().toLowerCase();
      const p = def.params.find((x) => x.toLowerCase() === k);
      if (!p) fail(`$${def.name}: no parameter $${k} — takes ${def.params.map((x) => "$" + x).join(", ") || "none"}`);
      out[p] = value(a.slice(eq + 1));
    }
    const missing = def.params.filter((p) => !(p in out));
    if (missing.length) fail(`$${def.name}: missing ${missing.map((p) => "$" + p).join(", ")}`);
    return out;
  }
  if (mixed) fail(`$${def.name}: name arguments all at once or not at all`);
  if (args.length < def.params.length) {
    fail(`$${def.name}: missing ${def.params.slice(args.length).map((p) => "$" + p).join(", ")}`);
  }
  if (args.length > def.params.length) {
    fail(`$${def.name}: too many arguments (takes ${def.params.length})`);
  }
  def.params.forEach((p, n) => { out[p] = value(args[n]); });
  return out;
}

/**
 * Substitute `$param` sites in a body. Textual, which is what makes
 * quantum-os#65's `match [$height] { [height] => … }` work: the argument lands
 * in the match subject and rholang's own `match` does the binding, so the body
 * stays ordinary rholang rather than a template language.
 *
 * `lexical` says whose rules the body is written under, and the two halves do
 * not agree. In **rholang** a `$` inside a string literal or a comment is
 * text, and skipping it is the language's own rule. In a **command** body
 * there are no string literals — `/gov say standup on "$topic" is open` is a
 * line somebody typed, the quotes are quotes, and a reader means that `$topic`
 * to be substituted. Treating command text as rholang there silently produces
 * a command with a `$topic` in it, which is the worst kind of wrong: it runs.
 *
 * @param {string} body
 * @param {Record<string,string>} bindings
 * @param {"rholang"|"text"} [lexical]
 * @returns {{text:string, substituted:string[]}}
 */
export function substitute(body, bindings, lexical = "rholang") {
  const text = String(body ?? "");
  const out = [];
  const substituted = [];
  let i = 0, last = 0;
  while (i < text.length) {
    const t = lexical === "rholang" ? skipTrivia(text, i) : -1;
    if (t !== -1) { i = t; continue; }
    if (text[i] !== "$") { i++; continue; }
    const m = /^\$([A-Za-z][A-Za-z0-9_-]*)/.exec(text.slice(i));
    if (!m) { i++; continue; }
    if (!(m[1] in bindings)) { i += m[0].length; continue; }   // a macro call site, not a parameter
    out.push(text.slice(last, i), bindings[m[1]]);
    substituted.push(m[1]);
    last = i + m[0].length;
    i = last;
  }
  out.push(text.slice(last));
  return { text: out.join(""), substituted };
}

// ---------------------------------------------------------------------------
// Call sites
// ---------------------------------------------------------------------------

/**
 * Expand every `$name` / `$name(…)` call site in a program.
 *
 * Errors never abort — every site is attempted so one report covers them all,
 * and a site that fails is left exactly as written rather than silently
 * dropped. Since `$` is illegal rholang, a site left in is a hard error at the
 * node rather than something that quietly means the wrong thing.
 *
 * `lexical` carries the same distinction `substitute` makes: rholang skips
 * string literals and comments, a command body does not.
 *
 * @param {string} src
 * @param {(name:string) => MacroDef|undefined} lookup
 * @param {number} [depth]
 * @param {"rholang"|"text"} [lexical]
 * @returns {{source:string, expansions:{name:string,line:number}[], errors:{line:number,message:string}[]}}
 */
export function expandCallSites(src, lookup, depth = 0, lexical = "rholang") {
  const text = String(src ?? "");
  const out = [];
  /** @type {{name:string,line:number}[]} */ const expansions = [];
  /** @type {{line:number,message:string}[]} */ const errors = [];
  if (depth > MAX_DEPTH) {
    return { source: text, expansions, errors: [{ line: 1, message: `macros nest more than ${MAX_DEPTH} deep — stopping` }] };
  }
  let i = 0, last = 0;
  while (i < text.length) {
    const t = lexical === "rholang" ? skipTrivia(text, i) : -1;
    if (t !== -1) { i = t; continue; }
    if (text[i] !== "$") { i++; continue; }
    const m = /^\$([A-Za-z][A-Za-z0-9_-]*)/.exec(text.slice(i));
    if (!m) { i++; continue; }
    const name = m[1].toLowerCase();
    const line = lineOf(text, i);
    let end = i + m[0].length;
    /** @type {string[]} */ let args = [];
    if (text[end] === "(") {
      const close = matchBracket(text, end);
      if (close === -1) {
        errors.push({ line, message: `$${name}: unbalanced ( — the call site is not closed` });
        break;
      }
      args = splitArgs(text.slice(end + 1, close));
      end = close + 1;
    }
    out.push(text.slice(last, i));
    const def = lookup(name);
    if (!def) {
      errors.push({ line, message: `unknown macro $${name} — try /macro list` });
      out.push(text.slice(i, end));                              // leave it as written
    } else {
      try {
        // A nested macro is expanded under its own body's rules, not its
        // caller's: a rholang fragment called from a command body is still
        // rholang, and a command body called from one is still command text.
        const inner1 = def.kind === "command" ? "text" : "rholang";
        const bound = substitute(def.body, bindArgs(def, args, def.kind === "command"), inner1).text;
        const inner = expandCallSites(bound, lookup, depth + 1, inner1);
        for (const e of inner.errors) errors.push({ line, message: `in $${name}: ${e.message}` });
        expansions.push({ name, line });
        for (const e of inner.expansions) expansions.push({ name: e.name, line });
        out.push(inner.source);
      } catch (e) {
        errors.push({ line, message: (e && e.message) || String(e) });
        out.push(text.slice(i, end));
      }
    }
    last = end;
    i = end;
  }
  out.push(text.slice(last));
  return { source: out.join(""), expansions, errors };
}

// ---------------------------------------------------------------------------
// Command bodies
// ---------------------------------------------------------------------------

/**
 * Split a command body into the commands it runs.
 *
 * A line beginning with `/` or `+` **at column 0** starts a new command;
 * anything else continues the one before it. That is what lets a body hold a
 * multi-line rholang program as the argument to `/rholang eval` — which is how
 * a `+command` reaches the chain — without needing a terminator:
 *
 *     /poll new $topic | yes, no
 *     /rholang eval
 *     new return in {
 *       return!($topic)
 *     }
 *
 * A blank line before the first command is skipped; a `//` line on its own is
 * a comment, matching `/script`.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function splitBody(body) {
  /** @type {string[]} */ const cmds = [];
  for (const line of String(body ?? "").split("\n")) {
    const starts = /^[/+]/.test(line);
    if (starts) {
      if (line.trim().startsWith("//")) { cmds.push(line.trim()); continue; }  // comment, kept for /script parity
      cmds.push(line);
    } else if (cmds.length) {
      cmds[cmds.length - 1] += "\n" + line;
    }
    // A non-command line before the first command belongs to no command: drop it.
  }
  return cmds.map((c) => c.replace(/\s+$/, "")).filter((c) => c.trim().length > 0);
}

/**
 * Everything `+name args` needs to run: the commands, and what went into them.
 * @param {MacroDef} def
 * @param {string[]} args
 * @param {(name:string) => MacroDef|undefined} lookup
 * @param {number} [depth]
 */
export function expandCommand(def, args, lookup, depth = 0) {
  if (def.kind !== "command") {
    fail(`$${def.name} is rholang, not a command — use it as $${def.name}(…) inside a /rholang program`);
  }
  const bound = substitute(def.body, bindArgs(def, args, true), "text");
  const expanded = expandCallSites(bound.text, lookup, depth + 1, "text");
  return {
    commands: splitBody(expanded.source),
    source: expanded.source,
    expansions: expanded.expansions,
    errors: expanded.errors,
  };
}

/** The definition as it would be typed back in — what `/macro show` prints. */
export function formatDefinition(def) {
  const head = def.name + (def.params.length ? `(${def.params.join(", ")})` : "");
  return head + (def.doc ? `  // ${def.doc}` : "") + "\n" + def.body;
}

/** One-line summary, for `/macro list` and `/macro find`. */
export function summarize(def) {
  const head = `+${def.name}` + (def.params.length ? ` ${def.params.map((p) => "<" + p + ">").join(" ")}` : "");
  return { head, kind: def.kind, doc: def.doc };
}

/**
 * Macros whose name, doc or body matches a regular expression (or all of them
 * when the pattern is empty) — MacRhoLang's `find:`.
 * @param {Iterable<MacroDef>} defs
 * @param {string} pattern
 */
export function findMacros(defs, pattern) {
  const all = [...defs].sort((a, b) => a.name.localeCompare(b.name));
  const p = String(pattern ?? "").trim();
  if (!p) return all;
  let re;
  try { re = new RegExp(p, "i"); } catch { fail(`not a valid pattern: ${p}`); }
  return all.filter((d) => re.test(d.name) || re.test(d.doc || "") || re.test(d.body));
}

// ---------------------------------------------------------------------------
// Selftest — node packages/browser/src/macro-lang.js --selftest
// ---------------------------------------------------------------------------

export function selftest() {
  let pass = 0, fail_ = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail_++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
  };
  const store = new Map();
  const lookup = (n) => store.get(n);
  const def = (text, author = "peer1") => {
    const d = parseDefinition(text);
    const full = { ...d, author, authorLabel: "tester", at: 0 };
    store.set(full.name, full);
    return full;
  };

  // --- definitions ---
  const standup = def(`standup(topic)  // opens a standup poll\n/poll new $topic | yes, no, later\n/gov say standup on $topic is open`);
  ok("parses bare name, params and doc", standup.name === "standup" && standup.params[0] === "topic" && standup.doc === "opens a standup poll");
  ok("command body is recognised as commands", standup.kind === "command");

  const inline = def("greet(who) Hi $who, welcome!");
  ok("inline body on the signature line", inline.name === "greet" && inline.params[0] === "who" && inline.body === "Hi $who, welcome!" && inline.kind === "rholang");

  const cmdInline = def("hi(who) +greet $who");
  ok("inline command body", cmdInline.kind === "command" && cmdInline.body === "+greet $who");

  const noParen = def("motd Nothing to report today");
  ok("no parameter list at all", noParen.name === "motd" && noParen.params.length === 0 && noParen.body === "Nothing to report today");

  const print = def(`$print($expression)\nnew stdout(\`rho:io:stdout\`) in { stdout!($expression) }`);
  ok("a leading $ and $params are still tolerated", print.name === "print" && print.params[0] === "expression" && print.kind === "rholang");

  const ballot = def("ballotid\n`rho:id:3qfh1fy7jwfcai7ceyorux4a18hzcn83n9xb6dramjf5gs7cw8fynf`");
  ok("value macro takes no parameters", ballot.params.length === 0 && ballot.kind === "rholang");

  const threw = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
  ok("a body is required", /no body/.test(threw(() => parseDefinition("empty(a)"))));
  ok("a bare doc with no body is refused", /no body/.test(threw(() => parseDefinition("empty(a)  // just a doc"))));
  ok("a parameter must be a plain name", /must be a plain name/.test(threw(() => parseDefinition("x(1a)  /id"))));
  ok("duplicate parameters are refused", /named twice/.test(threw(() => parseDefinition("x(a, a)  /id"))));
  ok("a definition needs a name", /a definition is:/.test(threw(() => parseDefinition("(topic) /id"))));

  // --- invocation + binding ---
  const inv = parseInvocation('+standup "Q4 budget"');
  ok("quotes group an argument", inv.name === "standup" && inv.args.length === 1 && inv.args[0] === '"Q4 budget"', JSON.stringify(inv.args));
  ok("a quoted value stays one named argument",
     parseInvocation('+standup topic="Q4 budget"').args.length === 1, JSON.stringify(parseInvocation('+standup topic="Q4 budget"').args));
  ok("positional binding", bindArgs(standup, ["Q4"]).topic === "Q4");
  ok("named binding", bindArgs(standup, ["topic=Q4"]).topic === "Q4");
  ok("a command argument loses its quotes", bindArgs(standup, ['"Q4 budget"']).topic === "Q4 budget");
  ok("a named command argument loses its quotes", bindArgs(standup, ['topic="Q4 budget"']).topic === "Q4 budget");
  ok("a rholang term keeps its quotes", bindArgs(standup, ['"Q4 budget"'], false).topic === '"Q4 budget"');
  ok("mixed naming is refused", /all at once or not at all/.test(threw(() => bindArgs(def("$two($a, $b)\n/id"), ["x", "b=y"]))));
  ok("missing arguments are named", /missing \$topic/.test(threw(() => bindArgs(standup, []))));
  ok("extra arguments are refused", /too many/.test(threw(() => bindArgs(standup, ["a", "b"]))));

  // --- substitution ---
  const sub = substitute("/poll new $topic | yes", { topic: "Q4 budget" });
  ok("substitutes a parameter", sub.text === "/poll new Q4 budget | yes");
  ok('a $ inside a string is text', substitute('return!("$topic")', { topic: "X" }).text === 'return!("$topic")');
  ok("a $ inside a comment is text", substitute("// $topic\n/id", { topic: "X" }).text === "// $topic\n/id");
  ok("an unbound $ is left alone", substitute("$other", { topic: "X" }).text === "$other");
  ok("in command text a quote is not a string literal",
     substitute('/gov say on "$topic" now', { topic: "Q4" }, "text").text === '/gov say on "Q4" now');
  ok("in command text // is not a comment",
     substitute("/note grant USD 5 | see http://x/$topic", { topic: "Q4" }, "text").text === "/note grant USD 5 | see http://x/Q4");

  // --- command expansion ---
  const quoted = def('$say($topic)\n/gov say standup on "$topic" is open');
  ok("a command body substitutes inside quotes",
     expandCommand(quoted, ["Q4"], lookup).commands[0] === '/gov say standup on "Q4" is open',
     JSON.stringify(expandCommand(quoted, ["Q4"], lookup).commands));

  const run = expandCommand(standup, ["Q4 budget"], lookup);
  ok("expands to its commands", run.commands.length === 2 && run.commands[0] === "/poll new Q4 budget | yes, no, later", run.commands.join(" ¶ "));
  ok("no errors on a good expansion", run.errors.length === 0, JSON.stringify(run.errors));
  ok("a rholang macro is not a command", /is rholang, not a command/.test(threw(() => expandCommand(print, ["1"], lookup))));

  // A multi-line rholang argument stays attached to its command.
  const deployer = def('$ship($msg)\n/rholang eval\nnew return in {\n  return!($msg)\n}');
  const shipped = expandCommand(deployer, ["hi"], lookup);
  ok("a multi-line argument stays one command",
     shipped.commands.length === 1 && shipped.commands[0] === '/rholang eval\nnew return in {\n  return!(hi)\n}',
     JSON.stringify(shipped.commands));

  // --- call sites ---
  const site = expandCallSites('new x in { $print("hello") }', lookup);
  ok("expands a $name(…) site", site.source === "new x in { new stdout(`rho:io:stdout`) in { stdout!(\"hello\") } }", site.source);
  ok("records the expansion", site.expansions.length === 1 && site.expansions[0].name === "print");

  const bare = expandCallSites("$ballotid", lookup);
  ok("expands a value macro with no parens", bare.source.startsWith("`rho:id:"), bare.source);

  const unknown = expandCallSites("new x in { $nosuch(1) }", lookup);
  ok("an unknown macro is reported, not dropped", unknown.errors.length === 1 && unknown.source.includes("$nosuch(1)"));
  ok("the error carries a line number", unknown.errors[0].line === 1);

  const inString = expandCallSites('return!("$print(1)")', lookup);
  ok("a call site inside a string is text", inString.expansions.length === 0 && inString.source === 'return!("$print(1)")');

  // Nesting, and its bound.
  def("$inner($a)\nvalue $a");
  def("$outer($a)\n[$inner($a)]");
  ok("macros nest", expandCallSites("$outer(7)", lookup).source === "[value 7]");
  def("$loop($a)\n$loop($a)");
  const looped = expandCallSites("$loop(1)", lookup);
  ok("recursion is bounded, not hung", looped.errors.length > 0 && /nest more than/.test(looped.errors[0].message), JSON.stringify(looped.errors[0]));

  // A command macro calling another command macro.
  def("$greet($who)\n/gov say hello $who");
  def("$open($topic, $who)\n+standup $topic\n+greet $who");
  const nested = expandCommand(lookup("open"), ["Q4", "bob"], lookup);
  ok("a +command body may invoke another",
     nested.commands.length === 2 && nested.commands[0] === "+standup Q4",
     JSON.stringify(nested.commands));

  // --- find ---
  ok("find matches the doc", findMacros(store.values(), "standup poll").some((d) => d.name === "standup"));
  ok("find with no pattern lists all", findMacros(store.values(), "").length === store.size);

  console.log(`selftest: ${pass}/${pass + fail_} passed`);
  return fail_ === 0;
}

if (typeof process !== "undefined" && process.argv && process.argv.includes("--selftest")) {
  process.exit(selftest() ? 0 : 1);
}

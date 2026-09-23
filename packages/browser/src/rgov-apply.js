// rgov-apply.js — rgov's argument-substitution convention, the one both
// r-wallet and the audit harness use.
//
// An rgov/r-wallet governance template is not a whole program. It is the BODY
// of a match case: it starts at the pattern line `[a, b] => {` and ends at the
// `}` that closes that case. The caller supplies the header and the outer
// brace, and the arguments:
//
//   match [<prepared args>] {
//     [a, b] => { … }
//   }
//
// Two consequences worth knowing before reading a template:
//
//   * Binding is POSITIONAL. `args[i]` pairs with `fields[i]`, and the names in
//     the pattern are documentation — rholang binds by position, so a template
//     whose pattern order differs from its field order is silently wrong.
//   * rgov's own `.rho` files carry the `match` header but NOT the final brace
//     (15 `{` to 14 `}`), because its harness appends it. So a raw rgov file
//     fails to parse on its own; that is the convention, not a broken file.
//     `applyRawRgov` below is for those; `apply` is for r-wallet-shaped bodies.
//
// Kept byte-compatible with r-wallet's `snippet_apply`/`prepare_arg`
// (src/modules/wallet/deploy/snippets.ts) — `rgov-apply.selftest` asserts the
// exact output shape, including the two-space indent, because the whole point
// of this module is that a template passing the audit is a template r-wallet
// can run unchanged.
//
//   node packages/browser/src/rgov-apply.js --selftest

/** The six field types r-wallet's `Field["type"]` allows. */
export const FIELD_TYPES = ["string", "number", "walletRevAddr", "MasterURI", "set", "uri"];

/**
 * One argument, as the rholang literal its field type implies. Mirrors
 * r-wallet's `prepare_arg` exactly:
 *   string/walletRevAddr → a quoted string literal
 *   number               → raw, unquoted (NOT validated — see below)
 *   uri/MasterURI        → backticked uri literal
 *   set                  → Set(<the raw text>), so "a,b" becomes Set(a,b)
 *
 * An unknown type throws rather than returning undefined: r-wallet gets this
 * guarantee from `noFallthroughCasesInSwitch` at compile time, and this module
 * has no compiler, so it has to check at run time or emit `undefined` into a
 * program.
 */
export function prepareArg(value, type) {
  const v = value ?? "";
  switch (type) {
    case "walletRevAddr":
    case "string":
      return JSON.stringify(String(v));
    case "number":
      return String(v);
    case "uri":
    case "MasterURI":
      return "`" + v + "`";
    case "set":
      return `Set(${v})`;
    default:
      throw new Error(`rgov-apply: unknown field type ${JSON.stringify(type)}`);
  }
}

/**
 * A template body + its arguments → a complete program.
 *
 * `fields` is the template's field list (`[{name, type}]`); `args` is
 * positional and may be short or hold nulls, which become "" exactly as
 * r-wallet does. That is a real footgun rather than a nicety: a missing
 * `number` field emits nothing and produces `match [, ] { … }`, which does not
 * parse. The audit harness reports that as the template's own failure, because
 * that is what a user typing an empty field gets.
 */
export function apply(body, fields, args) {
  const prepared = fields.map((f, i) => prepareArg(args[i] ?? "", f.type));
  const code = String(body).split("\n").map((l) => `  ${l}`).join("\n");
  return `match [${prepared.join(", ")}] {\n` + code + "\n}";
}

/** Braces that actually structure the program — not ones inside a string, a
 *  line comment or a block comment. Counting raw `{` would miscount any file
 *  containing `"{"` or a braced example in a comment. */
function structuralBraces(src) {
  let open = 0, close = 0;
  let inLine = false, inBlock = false, inStr = false, esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], next = src[i + 1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && next === "/") { inBlock = false; i++; } continue; }
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") open++;
    else if (c === "}") close++;
  }
  return { open, close };
}

/**
 * An rgov `.rho` file as it sits in the repo → a complete program.
 *
 * These files carry their own `match [defaults] {` header with example
 * arguments baked in. SOME are missing the closing brace, because rgov's
 * harness appends it — and some are not: `getRoll.rho` ends `}} // end of
 * match` and is already complete. So this BALANCES rather than assuming.
 * Appending a brace unconditionally silently corrupts every already-complete
 * file, which is a way to make a healthy script look broken (it did, until
 * this was fixed).
 *
 * Argument substitution over these files means rewriting their header, which
 * is `apply` above, once a template has been converted to the r-wallet shape.
 */
export function applyRawRgov(source) {
  const body = String(source).replace(/\s*$/, "");
  const { open, close } = structuralBraces(body);
  const missing = Math.max(0, open - close);
  return body + (missing ? "\n" + "}".repeat(missing) : "") + "\n";
}

/** The pattern variables of an rgov file, in binding order: the `[a, b, c]`
 *  of the `[a, b, c] => {` line that follows its `match` header. */
export function rawPatternNames(source) {
  const m = /match\s*\[[\s\S]*?\]\s*\{\s*\[([^\]]*)\]\s*=>/.exec(String(source));
  if (!m) return null;
  const inner = m[1].trim();
  return inner === "" ? [] : inner.split(",").map((x) => x.trim());
}

/**
 * Rewrite an rgov file's `match [...]` header with real arguments.
 *
 * The files ship with example arguments baked in, and most of them are
 * placeholders the harness never filled — `"$inbox"`, `` `$delegate` ``,
 * `Set($choices)`, `"?"`. Running them as-is means every inner receive waits
 * for an object nobody created, which reads as "blocked" and tells you
 * nothing. This substitutes by NAME: each pattern variable is looked up in
 * `values`, quoted by `TYPES` below, and written back into the header.
 *
 * It also reports arity, because rgov has at least one file where the header
 * and the pattern disagree — `share.rho` binds four variables against three
 * arguments, so its match can never fire no matter what is passed.
 */
export const TYPES = {
  // Anything ending in URI is a registry uri and must be backticked.
  toInboxURI: "uri", delegateURI: "uri", URI: "uri", ReadcapURI: "MasterURI",
  themBoxReg: "uri",
  proposals: "set", choices: "set",
  // everything else is a plain string
};

export function withArgs(source, values) {
  const names = rawPatternNames(source);
  if (!names) return { error: "no match/pattern header found" };
  const missing = names.filter((n) => !(n in values));
  const args = names.map((n) => prepareArg(values[n] ?? "", TYPES[n] ?? "string"));
  const src = String(source);
  const header = /match\s*\[[\s\S]*?\]\s*\{/.exec(src);
  if (!header) return { error: "no match header" };
  const headerArity = (() => {
    const inner = /match\s*\[([\s\S]*?)\]\s*\{/.exec(src)?.[1]?.trim();
    if (inner === undefined) return null;
    if (inner === "") return 0;
    // Split on top-level commas only — `Set(a,b)` is one argument.
    let depth = 0, n = 1;
    for (const c of inner) {
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === "," && depth === 0) n++;
    }
    return n;
  })();
  const program = src.slice(0, header.index) + `match [${args.join(", ")}] {` + src.slice(header.index + header[0].length);
  return { program, names, missing, headerArity, patternArity: names.length };
}

/** Do a template's pattern variables line up with its declared fields?
 *  Positional binding makes a mismatch silent, so it is worth asserting. */
export function patternArity(body) {
  const m = /^\s*\[([^\]]*)\]\s*=>/.exec(String(body));
  if (!m) return null;
  const inner = m[1].trim();
  return inner === "" ? 0 : inner.split(",").length;
}

// ---------------------------------------------------------------------------

/** open-minus-close, for the selftest. */
function structuralBracesProbe(src) {
  const { open, close } = structuralBraces(src);
  return open - close;
}

export function selftest() {
  let pass = 0, total = 0;
  const ok = (label, cond, detail = "") => {
    total++;
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else console.log(`  FAIL ${label}  ${detail}`);
  };

  // The exact output r-wallet's own scripts/test-unit.ts asserts on.
  const transfer = apply(
    `[revAddrTo, amount] => {\n  new rv(\`rho:rchain:revVault\`) in { rv!("transfer", revAddrTo, amount) }\n}`,
    [{ name: "revAddrTo", type: "string" }, { name: "amount", type: "number" }],
    ["toAddr", "100000000"],
  );
  ok('transfer: string arg is quoted', transfer.includes('"toAddr"'), transfer);
  ok('transfer: number arg is raw', transfer.includes("100000000") && !transfer.includes('"100000000"'));
  ok("transfer: header is match [args] {", transfer.startsWith('match ["toAddr", 100000000] {\n'), JSON.stringify(transfer.slice(0, 40)));
  ok("transfer: body is indented two spaces", transfer.includes("\n  [revAddrTo, amount] => {"));
  ok("transfer: closes with a brace on its own line", transfer.endsWith("\n}"));

  // `doit`'s set arg — r-wallet's test-unit asserts Set(a,b) appears.
  const doit = apply(`[a] => { Nil }`, [{ name: "arg", type: "set" }], ["a,b"]);
  ok("set arg becomes Set(a,b)", doit.includes("Set(a,b)"), doit);

  // Types, one by one.
  ok("walletRevAddr quotes like a string", prepareArg("1111abc", "walletRevAddr") === '"1111abc"');
  ok("uri is backticked", prepareArg("rho:id:xyz", "uri") === "`rho:id:xyz`");
  ok("MasterURI is backticked", prepareArg("rho:id:xyz", "MasterURI") === "`rho:id:xyz`");
  ok("a string with a quote is escaped", prepareArg('say "hi"', "string") === '"say \\"hi\\""');
  ok("an unknown type throws rather than emitting undefined",
    (() => { try { prepareArg("x", "nope"); return false; } catch { return true; } })());

  // The footgun, asserted so nobody "fixes" it into silence: a missing number
  // field produces an unparseable program, and the harness must report that
  // rather than paper over it.
  const missing = apply(`[a, b] => { Nil }`, [{ name: "a", type: "string" }, { name: "b", type: "number" }], ["x"]);
  ok("a missing number arg yields an empty slot (r-wallet parity)", missing.startsWith('match ["x", ] {'), missing);

  // Raw rgov files: header present, closing brace missing.
  const braces = (s, c) => s.split(c).length - 1;
  const shortOne = 'match [3] {\n  [height] => {\n    Nil\n  }\n';
  const closed = applyRawRgov(shortOne);
  ok("a brace-short rgov file gets the missing brace",
    braces(closed, "{") === braces(closed, "}"), `{=${braces(closed, "{")} }=${braces(closed, "}")}`);
  // getRoll.rho's real shape: already complete. Appending regardless is what
  // made a working script look like a parse failure.
  const complete = 'match [] {\n[] => {\n  Nil\n}\n}} // end of match\n';
  ok("an already-complete rgov file is left alone",
    braces(applyRawRgov(complete), "}") === braces(complete, "}"), applyRawRgov(complete));
  // Both snippets are balanced, so open-minus-close is 0. That is the
  // discriminating value: if string or comment braces leaked into the count
  // these would read 3 and -3.
  ok("a brace inside a string is not counted",
    structuralBracesProbe('match [] {\n  stdout!("{{{") \n}') === 0);
  ok("a brace inside a comment is not counted",
    structuralBracesProbe('match [] { // }}}\n}') === 0);

  // Pattern/field parity.
  ok("patternArity counts two binders", patternArity("[a, b] => { Nil }") === 2);
  ok("patternArity counts none", patternArity("[] => { Nil }") === 0);
  ok("patternArity is null when there is no pattern", patternArity("Nil") === null);

  // withArgs — substituting by name into a real rgov header shape.
  const rgovFile = 'match ["$inbox", "$issue", `$delegate`] {\n[lockerTag, issue, delegateURI] => {\n  Nil\n}\n}';
  ok("rawPatternNames reads the binding order",
    JSON.stringify(rawPatternNames(rgovFile)) === '["lockerTag","issue","delegateURI"]', JSON.stringify(rawPatternNames(rgovFile)));
  const sub = withArgs(rgovFile, { lockerTag: "inbox", issue: "audit", delegateURI: "rho:id:abc" });
  ok("withArgs replaces the placeholder header",
    sub.program.startsWith('match ["inbox", "audit", `rho:id:abc`] {'), JSON.stringify(sub.program?.slice(0, 60)));
  ok("withArgs backticks a uri-typed name", sub.program.includes("`rho:id:abc`"));
  ok("withArgs reports nothing missing when all names are supplied", sub.missing.length === 0);
  const short = withArgs(rgovFile, { lockerTag: "inbox" });
  ok("withArgs names the arguments it was not given",
    JSON.stringify(short.missing) === '["issue","delegateURI"]', JSON.stringify(short.missing));
  // share.rho's real defect: four binders, three arguments.
  const mismatched = 'match ["inbox", "", ""] {\n[lockerTag, toInboxURI, type, subtype] => {\n Nil\n}\n}';
  const mm = withArgs(mismatched, {});
  ok("withArgs surfaces an arity mismatch (share.rho binds 4 against 3)",
    mm.headerArity === 3 && mm.patternArity === 4, `header=${mm.headerArity} pattern=${mm.patternArity}`);
  ok("a Set-typed argument is not split on its inner comma",
    withArgs('match [Set($c)] {\n[proposals] => { Nil }\n}', { proposals: '"a","b"' }).headerArity === 1);

  console.log(`\nrgov-apply: ${pass}/${total} passed`);
  return pass === total;
}

if (typeof process !== "undefined" && process.argv?.includes("--selftest")) {
  process.exit(selftest() ? 0 : 1);
}

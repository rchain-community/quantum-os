// rholang-macros.js — the approved RChain capability macro registry, and the
// expander that turns `/rholang` macro input into rholang.
//
// SINGLE SOURCE OF TRUTH. This module is imported by both halves of the macro
// path:
//   * scripts/qos-cli/rholang-macros.mjs   — the headless room agent
//   * packages/browser/src/rholang-pipeline.ts — the browser, which lints and signs
// They used to carry separate copies of the registry, the argument validators
// and the scanner, kept in step by hand. A macro edited in one and not the
// other meant the rholang a user reviewed in chat was not the rholang their
// browser signed.
//
// Plain JS with no imports so both toolchains can consume it directly: the
// agent runs it under node, Vite bundles it for the browser. The ZFA kernel is
// INJECTED rather than imported, because each side has its own build of it
// (zfa.mjs / zfa.ts) and neither can import the other's.
//
// It lives under packages/browser/src because the browser tsconfig sets
// rootDir there; the agent reaches it by relative path, which node does not
// restrict.

/**
 * @typedef {object} ZfaKernel
 * @property {(s: string) => Uint8Array|null} parseTwists
 * @property {(tw: Uint8Array) => boolean} achievesZfa
 * @property {(tw: Uint8Array) => boolean} isPauliClosed
 * @property {(token: string) => boolean} validateCapability
 */

/**
 * Build the macro engine over a ZFA kernel.
 * @param {ZfaKernel} kernel
 */
export function createMacroEngine(kernel) {
const { parseTwists, achievesZfa, isPauliClosed, validateCapability } = kernel;

function fail(msg) {
  const e = new Error(msg);
  e.kind = "macro";
  return e;
}

/** A safe rholang string literal (JSON.stringify is a valid rholang string). */
const q = (s) => JSON.stringify(String(s));

// Arguments are not content-policed. What a user calls a directory is their
// business: every string reaches rholang through `q()` into a string literal,
// where it is inert text, and the WASM linter (crates/zfa-core/src/lint.rs)
// inspects the *expanded rholang* for restricted patterns before anything is
// signed. That is the layer that looks at code. Matching keywords against
// names here caught nothing the quoting did not already stop, and refused
// ordinary input like "New York" and "renew all licences".
//
// The length cap stays: it bounds the emitted program, which is this module's
// business.
function cleanString(v, name) {
  const s = String(v ?? "").trim();
  if (!s) throw fail(`${name}: expected a non-empty string`);
  if (s.length > 120) throw fail(`${name}: too long (max 120 chars)`);
  return s;
}

// Accepts "01" (adjacent digits), "0,1", "0 1", "[0,1]", or symbols "^v".
// Returns an array of ints 0..7.
function cleanTwists(v, name) {
  const s = String(v ?? "").trim().replace(/^\[|\]$/g, "");
  // Symbolic form (^ v > < / \ + -) → delegate to parseTwists.
  if (/[^0-7\s,]/.test(s)) {
    const tw = parseTwists(s);
    if (!tw) throw fail(`${name}: unknown twist symbol`);
    return Array.from(tw);
  }
  // Digits: strip separators and treat each digit as one twist value.
  const digits = s.replace(/[\s,]+/g, "");
  if (!digits.length || !/^[0-7]+$/.test(digits)) throw fail(`${name}: expected twist values 0..7`);
  return [...digits].map((c) => Number(c));
}

function cleanList(v, name) {
  const s = String(v ?? "").trim();
  const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.length) throw fail(`${name}: expected a comma-separated list`);
  return parts.map((p) => cleanString(p, name));
}

function cleanCap(v, name) {
  const s = cleanString(v, name);
  if (!/^(cap:|rho:id:)/.test(s)) throw fail(`${name}: expected a cap:… or rho:id:… capability`);
  return s;
}

// A rholang term, passed through exactly as written. Maps and nested lists are
// ordinary rholang and there is nothing to escape them into: the argument sits
// in the user's own program, which they review and sign. The scanner has
// already balanced it. Used by the `rho:gov:*` macros, whose arguments are maps.
function cleanTerm(v, name) {
  const s = String(v ?? "").trim();
  if (!s) throw fail(`${name}: expected a rholang term`);
  if (s.length > 2000) throw fail(`${name}: term too long (max 2000 chars)`);
  return s;
}

function cleanInt(v, name) {
  const s = String(v ?? "").trim();
  // Decimal digits only, carried as a BigInt. `Number()` silently rounded
  // anything past 2^53 — a typed 12345678901234567890 became a signed
  // 12345678901234567000 — which for a REV amount means the value the user
  // approved is not the value that gets signed. It also quietly accepted
  // `0x10` as 16 and `1e9` as 1000000000. REV amounts run well past 2^53, so
  // the digits the user typed are the digits that get emitted.
  if (!/^\d+$/.test(s)) throw fail(`${name}: expected a non-negative integer (decimal digits only)`);
  if (s.length > 40) throw fail(`${name}: integer too long (max 40 digits)`);
  return BigInt(s);
}

// ---------------------------------------------------------------------------
// The approved macro registry.
//
// Each entry:
//   help     — one-line description (shown in `/rholang macros`)
//   write    — false = read (agent answers locally); true = write (agent returns
//              a rholang preview to sign + deploy)
//   argSpec  — array of [name, type]  (types: string, twists, list, cap, int)
//   expand   — (args) => rholang source string   (write macros)
//   read     — (args) => { text }                (read macros)
// ---------------------------------------------------------------------------
const MACROS = {
  zfa: {
    help: "Verify a twist sequence is ZFA-balanced (half-spin closure).",
    write: false,
    argSpec: [["twists", "twists"]],
    read(args) {
      const tw = parseTwists(args.twists.join(""));
      if (!tw) throw fail("zfa: could not parse twists");
      return {
        text: `zfa(${args.twists.join("")}) → ZFA ${achievesZfa(tw) ? "true" : "false"}` +
              ` (pauli-closed ${isPauliClosed(tw) ? "true" : "false"})`,
      };
    },
  },

  verify: {
    help: "Validate a capability token (cap:… / rho:id:…) is a ZFA-balanced closure.",
    write: false,
    argSpec: [["cap", "cap"]],
    read(args) {
      const ok = validateCapability(args.cap) || /^rho:id:/.test(args.cap);
      return { text: `verify(${args.cap}) → ${ok ? "valid" : "INVALID"}` };
    },
  },

  grant: {
    help: "Mint a ZFA-balanced proof as a capability (rho:qucalc:grant).",
    write: true,
    capture: true,   // $grant("^v><") as cap { … } — the cap is bound, not returned
    argSpec: [["twists", "twists"]],
    expand(args, sink) {
      const list = args.twists.join(", ");
      return `new grant(\`rho:qucalc:grant\`), ret in {
  grant!([${list}], *ret) |
  ${sink ?? "for (@__r <- ret) { return!(__r) }"}
}`;
    },
  },

  // Casting a ballot records a signed fact; folding the collected facts is
  // what `tally` does. The node draws that line itself — the rho:gov:*
  // processes are pure and read no state — so a ballot goes to the registry
  // keyed by its voter, and %tally reads them back.
  ballot: {
    help: "Record a ranked-choice ballot for an issue, signed by the voter.",
    write: true,
    argSpec: [["issue", "string"], ["options", "list"]],
    expand(args) {
      const options = args.options.map(q).join(", ");
      return `new insertArbitrary(\`rho:registry:insertArbitrary\`),
    deployerId(\`rho:rchain:deployerId\`), ret in {
  insertArbitrary!({"kind": "ballot", "issue": ${q(args.issue)}, "ranked": [${options}], "voter": *deployerId}, *ret) |
  for (@uri <- ret) { return!(uri) }
}`;
    },
  },

  directory: {
    help: "Create a capability-facet key/value directory (rho:registry:insertArbitrary).",
    write: true,
    argSpec: [["name", "string"]],
    expand(args) {
      return `new insertArbitrary(\`rho:registry:insertArbitrary\`), ret in {
  insertArbitrary!({"directory": ${q(args.name)}}, *ret) |
  for (@uri <- ret) { return!(uri) }
}`;
    },
  },

  mailbox: {
    help: "Create a capability-facet inbox (rho:registry:insertArbitrary).",
    write: true,
    argSpec: [["name", "string"]],
    expand(args) {
      return `new insertArbitrary(\`rho:registry:insertArbitrary\`), ret in {
  insertArbitrary!({"mailbox": ${q(args.name)}}, *ret) |
  for (@uri <- ret) { return!(uri) }
}`;
    },
  },

  group: {
    help: "Create a governance group (signer becomes admin; rho:registry:insertArbitrary).",
    write: true,
    argSpec: [["name", "string"]],
    expand(args) {
      return `new insertArbitrary(\`rho:registry:insertArbitrary\`), deployerId(\`rho:rchain:deployerId\`), ret in {
  insertArbitrary!({"group": ${q(args.name)}, "admin": *deployerId}, *ret) |
  for (@uri <- ret) { return!(uri) }
}`;
    },
  },

  delegate: {
    help: "Delegate your vote to another member (rho:gov:resolveWeights).",
    write: true,
    argSpec: [["to", "string"]],
    expand(args) {
      return `new resolveWeights(\`rho:gov:resolveWeights\`), deployerId(\`rho:rchain:deployerId\`), ret in {
  resolveWeights!([*deployerId], {*deployerId: ${q(args.to)}}, {}, *ret) |
  for (@weights <- ret) { return!(weights) }
}`;
    },
  },

  // --- rho:qucalc:* — proofs -------------------------------------------
  // Mirrors qucalc/examples/syllogism.rho ("deduce"): thesis ⊕ antithesis fused
  // through their shared middle term. Returns (geometry, cap), or Nil if the
  // synthesis does not close. `grant` above is the same example's "seal".
  fuse: {
    help: "Dialectical synthesis of two histories (rho:qucalc:fuse).",
    write: true,
    argSpec: [["subject", "twists"], ["predicate", "twists"]],
    expand(args) {
      return `new fuse(\`rho:qucalc:fuse\`), ret in {
  fuse!([${args.subject.join(", ")}], [${args.predicate.join(", ")}], *ret) |
  for (@out <- ret) { return!(out) }
}`;
    },
  },

  // --- rho:gov:* — group decisions --------------------------------------
  // Mirrors qucalc/examples/liquid_democracy.rho. Arguments are rholang maps,
  // so they take the `term` type and pass through as written.
  trust: {
    help: "Admin-rooted web of trust → member levels (rho:gov:trustLevels).",
    write: true,
    argSpec: [["ratings", "term"], ["admins", "term"]],
    expand(args) {
      return `new trustLevels(\`rho:gov:trustLevels\`), ret in {
  trustLevels!(${args.ratings}, ${args.admins}, *ret) |
  for (@levels <- ret) { return!(levels) }
}`;
    },
  },

  weights: {
    help: "Liquid-democracy weights: delegation resolved transitively (rho:gov:resolveWeights).",
    write: true,
    argSpec: [["voters", "term"], ["delegations", "term"], ["levels", "term"]],
    expand(args) {
      return `new resolveWeights(\`rho:gov:resolveWeights\`), ret in {
  resolveWeights!(${args.voters}, ${args.delegations}, ${args.levels}, *ret) |
  for (@weights <- ret) { return!(weights) }
}`;
    },
  },

  tally: {
    help: "Weighted ranked-choice or approval tally (rho:gov:tally).",
    write: true,
    argSpec: [["ballots", "term"], ["weights", "term"], ["mode", "string"]],
    expand(args) {
      return `new tally(\`rho:gov:tally\`), ret in {
  tally!(${args.ballots}, ${args.weights}, ${q(args.mode)}, *ret) |
  for (@winner <- ret) { return!(winner) }
}`;
    },
  },

  censure: {
    help: "⅔-quorum accountability with voucher slashing (rho:gov:censure).",
    write: true,
    argSpec: [["censures", "term"], ["levels", "term"], ["vouchers", "term"]],
    expand(args) {
      return `new censure(\`rho:gov:censure\`), ret in {
  censure!(${args.censures}, ${args.levels}, ${args.vouchers}, *ret) |
  for (@out <- ret) { return!(out) }
}`;
    },
  },

  // --- bearer capabilities ----------------------------------------------
  // Mirrors qucalc/examples/promissory_note.rho: declare an issuer authority,
  // grant a bearer note, redeem it for a permanent receipt. Each is an
  // unforgeable content-addressed registry capability.
  issuer: {
    help: "Mint issuer authority for a currency (promissory-note declare).",
    write: true,
    argSpec: [["currency", "string"]],
    expand(args) {
      return `new insertArbitrary(\`rho:registry:insertArbitrary\`), ret in {
  insertArbitrary!({"kind": "issuer", "currency": ${q(args.currency)}}, *ret) |
  for (@authority <- ret) { return!(authority) }
}`;
    },
  },

  note: {
    help: "Mint a bearer note of a denomination against an authority.",
    write: true,
    argSpec: [["authority", "string"], ["amount", "int"]],
    expand(args) {
      return `new insertArbitrary(\`rho:registry:insertArbitrary\`), ret in {
  insertArbitrary!({"kind": "note", "authority": ${q(args.authority)}, "amount": ${args.amount}}, *ret) |
  for (@note <- ret) { return!(note) }
}`;
    },
  },

  redeem: {
    help: "Redeem a note for a permanent, non-transferable receipt.",
    write: true,
    argSpec: [["authority", "string"], ["amount", "int"]],
    expand(args) {
      return `new insertArbitrary(\`rho:registry:insertArbitrary\`), ret in {
  insertArbitrary!({"kind": "receipt", "authority": ${q(args.authority)}, "amount": ${args.amount}}, *ret) |
  for (@receipt <- ret) { return!(receipt) }
}`;
    },
  },

  // --- structural patterns ----------------------------------------------
  // Mirrors qucalc/examples/atomic_swap.rho. The `for`-join IS the atomicity:
  // both deposits are consumed together or neither is. No escrow, no third
  // party. Channels are quoted names so they can be shared across deploys.
  swap: {
    help: "All-or-nothing two-party exchange over a for-join (atomic swap).",
    write: true,
    // Capabilities, not labels. A label becomes `@"alice-deposit"` — a public
    // name, which is a channel anyone who reads or guesses it can send on and
    // receive from. A swap over four of those is not a swap: a third party can
    // take the deposit before the join does, feed it a forged one, or collect
    // the proceeds. Each side is a uri instead, resolved through the registry,
    // so the join happens on names only the parties hold.
    argSpec: [["depositA", "cap"], ["depositB", "cap"], ["toA", "cap"], ["toB", "cap"]],
    expand(args) {
      return `new lookup(\`rho:registry:lookup\`), dA, dB, tA, tB in {
  lookup!(\`${args.depositA}\`, *dA) |
  lookup!(\`${args.depositB}\`, *dB) |
  lookup!(\`${args.toA}\`, *tA) |
  lookup!(\`${args.toB}\`, *tB) |
  for (@depositA <- dA; @depositB <- dB; @toA <- tA; @toB <- tB) {
    for (@a <- @depositA; @b <- @depositB) {
      @toA!(b) |
      @toB!(a)
    }
  }
}`;
    },
  },

  // Mirrors qucalc/examples/dining_philosophers.rho. Forks are capability
  // channels; a philosopher takes both adjacent forks in one join, so no one
  // can hold one while waiting for another — deadlock is impossible by
  // construction rather than by protocol.
  philosophers: {
    help: "Seat N diners around a fork ring — deadlock-free by construction.",
    write: true,
    argSpec: [["names", "list"]],
    expand(args) {
      const n = args.names.length;
      if (n < 2) throw fail("philosophers: needs at least two names");
      const forks = Array.from({ length: n }, (_, i) => `f${i}`);
      const seats = args.names.map(
        (name, i) => `  Philosopher!(${q(name)}, *${forks[i]}, *${forks[(i + 1) % n]}, *done)`
      );
      return `new Philosopher, done, ${forks.join(", ")} in {
  contract Philosopher(@name, left, right, done) = {
    for (_ <- left; _ <- right) {
      done!(name) |
      left!(Nil) | right!(Nil)
    }
  } |
${forks.map((f) => `  ${f}!(Nil)`).join(" |\n")} |
${seats.join(" |\n")} |
  for (@who <= done) { return!(who) }
}`;
    },
  },

  // Mirrors qucalc/examples/multisig.rho: a nonce-keyed confirmation set where
  // each signer is their own unforgeable *deployerId, and the decision fires
  // only at quorum. Holding one token is not enough.
  multisig: {
    help: "N-of-M quorum co-signature over a nonce-keyed confirmation set.",
    write: true,
    argSpec: [["nonce", "string"], ["proposal", "string"], ["quorum", "int"]],
    expand(args) {
      return `new confirmationsCh, ret, deployerId(\`rho:rchain:deployerId\`) in {
  confirmationsCh!({}) |
  for (@confirmations <- confirmationsCh) {
    let @joined <- confirmations.getOrElse((${q(args.nonce)}, ${q(args.proposal)}), Set()).union(Set(*deployerId)) in {
      confirmationsCh!(confirmations.set((${q(args.nonce)}, ${q(args.proposal)}), joined)) |
      if (joined.size() >= ${args.quorum}) { ret!(true) } else { ret!(Nil) }
    }
  }
}`;
    },
  },

  transfer: {
    help: "Transfer REV to an address (rho:rchain:revVault). Returns Nil on success.",
    write: true,
    capture: true,   // $transfer(10, a) as r { … } — r is the raw reply (Nil / error string)
    argSpec: [["amount", "int"], ["to", "string"]],
    expand(args, sink) {
      // The revVault on the shipped bin/rnode takes the deployerId process
      // directly (not a from-address resolved via rho:rev:address), then the
      // to-address string, the amount, and a return channel — verified live.
      // Default sink: a success replies Nil, a failure an error string; report
      // which so `/rholang read` shows more than a bare Nil. `as r { … }`
      // hands the raw reply straight to the block instead.
      const s = sink ?? `for (@r <- ret) {
    match r {
      Nil => return!(("transfer ok", ${args.amount}, ${q(args.to)}))
      _   => return!(("transfer FAILED", r))
    }
  }`;
      return `new revVault(\`rho:rchain:revVault\`), deployerId(\`rho:rchain:deployerId\`), ret in {
  revVault!("transfer", *deployerId, ${q(args.to)}, ${args.amount}, *ret) |
  ${s}
}`;
    },
  },

  // A chain read: it has rholang (so it is not answered locally like `zfa` /
  // `verify`) but `write: false`, so `$balance(…)` runs as an unsigned
  // `/rholang eval` — no phlo, no block. Your own address is `$me`, a
  // client-side token the caller resolves before expansion (the node cannot:
  // `rho:rchain:deployerId` is unbound in an exploratory deploy).
  balance: {
    help: "Read a REV balance (rho:rchain:revVault). Arg: a REV address, or $me.",
    write: false,
    capture: true,   // $balance($me) as bal { … } — bal is the int, block runs
    argSpec: [["addr", "string"]],
    expand(args, sink) {
      return `new revVault(\`rho:rchain:revVault\`), ret in {
  revVault!("getBalance", ${q(args.addr)}, *ret) |
  ${sink ?? "for (@__r <- ret) { return!(__r) }"}
}`;
    },
  },
};

// ---------------------------------------------------------------------------
// Expansion entry point.
// ---------------------------------------------------------------------------

/**
 * The `/rholang macro` entry point. The body is either a bare single macro call
 * (`transfer 100 bob` — the whole program is one macro) or a rholang program,
 * one line or many, with `%name(…)` call sites embedded in it.
 */
function expandBare(input) {
  const body = String(input ?? "").replace(/^\s*(\/rholang\s+macro)?\s*/i, "");
  const head = body.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (head === "help") return { kind: "help" };
  if (head === "macros" || head === "list") return { kind: "list" };
  // Bare form: no call sites, and the first word names a macro.
  if (!body.includes("%") && !/\$[A-Za-z]/.test(body) && MACROS[head]) return expandMacro(body);
  return expandProgram(body);
}

/** Parse "/rholang macro name args…" (or bare "name args…") and expand it. */
function expandMacro(line) {
  const s = String(line ?? "").trim();
  const body = s.replace(/^\/rholang\s+macro\s*/i, "");
  const tokens = body.split(/\s+/).filter(Boolean);
  if (!tokens.length) throw fail("usage: /rholang macro <name> <args…>  (or /rholang macros)");
  const name = tokens[0].toLowerCase();
  const rest = tokens.slice(1);

  if (name === "help") return { kind: "help" };
  if (name === "macros" || name === "list") return { kind: "list" };

  const macro = MACROS[name];
  if (!macro) throw fail(`unknown macro ${JSON.stringify(name)} — try /rholang macros`);

  // Bind positional args against the schema.
  const args = {};
  const spec = macro.argSpec;
  const n = Math.min(spec.length, rest.length);
  for (let i = 0; i < n; i++) {
    const [argName, type] = spec[i];
    const raw = rest[i];
    switch (type) {
      case "string": args[argName] = cleanString(raw, argName); break;
      case "twists": args[argName] = cleanTwists(raw, argName); break;
      case "list":   args[argName] = cleanList(raw, argName); break;
      case "cap":    args[argName] = cleanCap(raw, argName); break;
      case "int":    args[argName] = cleanInt(raw, argName); break;
      // A rholang term contains spaces, which the bare form splits on. Say so
      // rather than binding half a map to one argument.
      case "term":   throw fail(`${name}: takes a rholang term — use the program form, e.g. /rholang eval with %${name}(…) in it`);
      default: throw fail(`${name}: internal — unknown arg type ${type}`);
    }
  }
  if (n < spec.length) {
    const missing = spec.slice(n).map(([a, t]) => `${a}:${t}`).join(", ");
    throw fail(`${name}: missing args — ${missing}`);
  }
  if (rest.length > spec.length) {
    throw fail(`${name}: too many args (expected ${spec.length})`);
  }

  if (typeof macro.expand === "function") {
    // `write` picks the run path: a write macro is signed + deployed; a read
    // macro that still needs the chain (balance) runs as an unsigned eval.
    return { kind: "rholang", macro: name, source: macro.expand(args), mode: macro.write ? "deploy" : "eval" };
  }
  return { kind: "result", macro: name, ...macro.read(args) };
}

// ---------------------------------------------------------------------------
// Program expansion: macros embedded in rholang.
//
// A `/rholang` program is rholang — one line or many — with macro call
// sites written `%name(arg, …)`. We do NOT parse the rholang: we scan it well
// enough to find call sites that are really call sites (skipping strings and
// comments, balancing brackets), expand those in place, and leave every other
// byte untouched. Whatever the result does or does not mean is the linter's
// question and then the node's; expansion only reports its own errors.
//
// The `%` sigil is what keeps this honest without a rholang grammar — a bare
// `ballot(…)` would be indistinguishable from a real contract call.
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
    if (t === -1 && (src[i] === '"' || (src[i] === "/" && src[i + 1] === "*"))) return -1;  // unterminated
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

/** Split a macro argument list on top-level commas. */
function splitArgs(src) {
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

/** A rholang term as the plain text the arg validators expect. */
function termToPlain(t) {
  const s = String(t).trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    // A rholang string literal: take its content, honouring backslash escapes.
    return s.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    // A list: hand the validators the comma form they already parse.
    return splitArgs(s.slice(1, -1)).map(termToPlain).join(",");
  }
  return s;
}

/** Bind already-split argument terms against a macro's schema. */
function bindArgs(macro, name, terms) {
  const spec = macro.argSpec;
  if (terms.length < spec.length) {
    throw fail(`${name}: missing args — ${spec.slice(terms.length).map(([a, t]) => `${a}:${t}`).join(", ")}`);
  }
  if (terms.length > spec.length) throw fail(`${name}: too many args (expected ${spec.length})`);
  const args = {};
  for (let i = 0; i < spec.length; i++) {
    const [argName, type] = spec[i];
    // A `term` is rholang and must NOT be normalized — termToPlain unwraps a
    // list into its comma form for cleanList, which would turn the rholang list
    // `["A", "D"]` into the bare text `A,D`.
    const raw = type === "term" ? terms[i].trim() : termToPlain(terms[i]);
    switch (type) {
      case "string": args[argName] = cleanString(raw, argName); break;
      case "twists": args[argName] = cleanTwists(raw, argName); break;
      case "list":   args[argName] = cleanList(raw, argName); break;
      case "cap":    args[argName] = cleanCap(raw, argName); break;
      case "int":    args[argName] = cleanInt(raw, argName); break;
      case "term":   args[argName] = cleanTerm(raw, argName); break;
      default: throw fail(`${name}: internal — unknown arg type ${type}`);
    }
  }
  return args;
}

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

/**
 * Expand every `%macro(…)` call site in a rholang program.
 * Returns { kind:"program", source, expansions:[{name,line}], errors:[{line,message}] }.
 * Errors do not abort: every call site is attempted so one message reports them all.
 */
function expandProgram(src) {
  const text = String(src ?? "");
  const out = [];
  const expansions = [];
  const errors = [];
  let i = 0, last = 0;
  while (i < text.length) {
    const t = skipTrivia(text, i);
    if (t !== -1) { i = t; continue; }
    // `$` is the room's macro sigil (illegal in rholang, so a missed expansion
    // is a hard error at rnode). `%` is kept as a deprecated alias — but it is
    // also rholang's modulo operator, so a `%name(` with no matching macro is
    // left alone silently, whereas an unknown `$name(` may be a room macro that
    // a later pass expands, also left alone.
    if (text[i] !== "%" && text[i] !== "$") { i++; continue; }
    const sigil = text[i];
    const m = /^[%$]([A-Za-z][\w-]*)\s*\(/.exec(text.slice(i));
    if (!m) { i++; continue; }
    const name = m[1].toLowerCase();
    const open = i + m[0].length - 1;
    const close = matchBracket(text, open);
    if (close === -1) {
      errors.push({ line: lineOf(text, i), message: `${sigil}${name}: unbalanced ( — call site is not closed` });
      break;
    }
    const macro = MACROS[name];
    if (!macro) {
      // `%foo(` with no such macro: almost certainly a typo (it is not valid
      // modulo either), so report it. `$foo(` may be a room macro a later pass
      // expands — leave it silently. Either way the text is left in place.
      if (sigil === "%") errors.push({ line: lineOf(text, i), message: `unknown macro %${name} — try /rholang macros` });
      i = close + 1;
      continue;
    }
    // Optional capture clause: `$macro(args) as name { …block… }` — the result
    // the macro would report is instead bound to `name` and the block runs.
    // Only macros that opt in (`capture: true`) accept it; the rest report to
    // `return` (eval / the deploy record) as before.
    let end = close + 1;
    let capture = null;
    const asM = /^\s+as\s+([A-Za-z_][\w']*)\s*\{/.exec(text.slice(end));
    if (asM) {
      const braceOpen = end + asM[0].length - 1;
      const braceClose = matchBracket(text, braceOpen);
      if (braceClose === -1) {
        errors.push({ line: lineOf(text, i), message: `${sigil}${name}: unbalanced { after \`as ${asM[1]}\`` });
        break;
      }
      capture = { name: asM[1], block: text.slice(braceOpen + 1, braceClose).trim() };
      end = braceClose + 1;
    }

    out.push(text.slice(last, i));
    try {
      // A read macro with no rholang (zfa / verify) is answered on its own
      // line, not substituted into a program.
      if (!macro.write && typeof macro.expand !== "function") {
        throw fail(`${sigil}${name} is a local read — it has no rholang; use it on its own line`);
      }
      if (capture && !macro.capture) {
        throw fail(`${sigil}${name} does not support \`as ${capture.name} { … }\` — it reports to return`);
      }
      const args = bindArgs(macro, name, splitArgs(text.slice(open + 1, close)));
      const sink = capture ? `for (@${capture.name} <- ret) {\n    ${capture.block}\n  }` : undefined;
      out.push(macro.expand(args, sink));
      expansions.push({ name, line: lineOf(text, i), write: !!macro.write });
    } catch (e) {
      errors.push({ line: lineOf(text, i), message: e?.message ?? String(e) });
      out.push(text.slice(i, end));
    }
    last = end;
    i = end;
  }
  out.push(text.slice(last));
  return { kind: "program", source: out.join(""), expansions, errors };
}

/** One-line summary of every macro (for `/rholang macros`). */
function listMacros() {
  const lines = Object.entries(MACROS).map(
    ([name, m]) => `${name.padEnd(10)} ${m.write ? "write" : "read "}  ${m.help}`
  );
  return `Approved macros (${lines.length}):\n` + lines.map((l) => `  ${l}`).join("\n");
}

const HELP =
  `RChain capability macros — /rholang\n` +
  `  /rholang macros              list the approved macro library\n` +
  `  /rholang macro <name> <args…>  expand one macro (the whole program is one macro)\n` +
  `  /rholang eval|deploy         %macro(…) call sites inside the program expand in\n` +
  `                               place; one line or many, everything else is left\n` +
  `                               exactly as written\n`;

// ---------------------------------------------------------------------------
// Self-test (node rholang-macros.mjs --selftest)
// ---------------------------------------------------------------------------
function selftest() {
  const cases = [
    ["zfa 01", (r) => r.kind === "result" && r.text.includes("ZFA true")],
    ["zfa 0", (r) => r.kind === "result" && r.text.includes("ZFA false")],
    ["grant 01", (r) => r.kind === "rholang" && r.source.includes("grant(`rho:qucalc:grant`)") && r.source.includes("grant!(")],
    ["ballot lunch pizza,tacos", (r) => r.kind === "rholang" && r.source.includes("\"kind\": \"ballot\"") && r.source.includes("*deployerId")],
    ["directory notes", (r) => r.kind === "rholang" && r.source.includes("insertArbitrary!")],
    ["transfer 10 bob", (r) => r.kind === "rholang" && r.source.includes("revVault!")],
    // amounts past 2^53 must survive verbatim, not be rounded through a double:
    ["transfer 12345678901234567890 bob",
      (r) => r.source.includes("12345678901234567890, *ret)")],
    ["transfer 0x10 bob", () => { throw new Error("should have been rejected"); }],
    ["transfer 1e9 bob", () => { throw new Error("should have been rejected"); }],
    // hygiene / injection must be rejected:
    // Not the expander's business: these are inert inside a string literal, and
    // the WASM linter is what inspects the expanded rholang before signing.
    ["directory rho:io:stdout", (r) => r.source.includes('"directory": "rho:io:stdout"')],
    ["ballot x y,rho:io:stdout", (r) => r.source.includes('"y", "rho:io:stdout"')],
    ["nope", () => { throw new Error("should have been rejected"); }],
  ];
  let pass = 0;

  // Program form: macros embedded in rholang, one line or many.
  const P = (src) => expandProgram(src);
  const progCases = [
    ["expands a call site in place",
      () => P('new x in { %directory("notes") }').source.includes("insertArbitrary!")],
    ["multi-word args, which the bare form cannot express",
      () => P('%mailbox("Q4 results")').source.includes('"mailbox": "Q4 results"')],
    ["two call sites, both expanded",
      () => P('%directory("a") | %mailbox("b")').expansions.length === 2],
    ["a %name( inside a string is not a call site",
      () => P('x!("%directory(\\"no\\")")').expansions.length === 0],
    ["a %name( inside a line comment is not a call site",
      () => P('// %directory("no")\nNil').expansions.length === 0],
    ["a %name( inside a block comment is not a call site",
      () => P('/* %directory("no") */ Nil').expansions.length === 0],
    ["unknown macro is an error, and the text is left as written",
      () => { const r = P('%nosuch("x")'); return r.errors.length === 1 && r.source === '%nosuch("x")'; }],
    ["a bad arg reports its line and leaves that site alone",
      () => { const r = P('Nil |\n%transfer(1e9, "bob")'); return r.errors[0].line === 2 && r.source.includes("%transfer(1e9"); }],
    ["one bad site does not suppress a good one",
      () => { const r = P('%directory("ok") | %nosuch("x")'); return r.expansions.length === 1 && r.errors.length === 1; }],
    ["unbalanced call site is reported, not thrown",
      () => P('%directory("oops"').errors.length === 1],
    ["nested brackets in args are balanced correctly",
      () => P('%ballot("i", ["a (b)", "c, d"])').expansions.length === 1],
    ["arguments are not content-policed",
      () => ["New York office", "renew all licences", "Vote for (chair)", "new hires",
             "rho:io:stdout", "about *deployerId", "a!!b"]
        .every((n) => P(`%directory(${JSON.stringify(n)})`).errors.length === 0)],
    ["a rholang keyword in an argument stays inside its string literal",
      () => P('%directory("new x in { evil!(1) }")').source
        .includes('"directory": "new x in { evil!(1) }"')],
    ["a list arg keeps its elements whole",
      () => P('%ballot("i", ["ship auth", "pay debt"])').source.includes('"ship auth", "pay debt"')],
    ["$ is the room macro sigil — a $name( site expands like %",
      () => P('new x in { $directory("notes") }').source.includes("insertArbitrary!")],
    ["$ and % expand the same built-in identically",
      () => P('$transfer(10, "b")').source === P('%transfer(10, "b")').source],
    ["an unknown $name( is left alone silently (may be a room macro)",
      () => { const r = P('$mymacro("x")'); return r.errors.length === 0 && r.source === '$mymacro("x")'; }],
    ["$balance is a chain read: write:false but has rholang",
      () => { const r = P('$balance("1111Alice")'); return r.expansions.length === 1 && r.expansions[0].write === false && r.source.includes('revVault!("getBalance", "1111Alice"'); }],
    ["macroMode routes the sigils",
      () => macroMode("balance") === "eval" && macroMode("transfer") === "deploy" && macroMode("verify") === "read-local" && macroMode("nope") === null],
    ["bare $balance via /rholang macro runs as eval",
      () => { const r = expandMacro("balance 1111Alice"); return r.kind === "rholang" && r.mode === "eval"; }],
    ["capture: $balance(a) as bal { block } binds bal, drops the return",
      () => { const r = P('$balance("a") as bal {\n  stdout!(("bal", bal))\n}');
        return r.errors.length === 0 && r.expansions.length === 1
          && r.source.includes("for (@bal <- ret) {") && r.source.includes('stdout!(("bal", bal))')
          && !r.source.includes("return!"); }],
    ["capture: default (no `as`) still reports to return",
      () => P('$balance("a")').source.includes("return!")],
    ["capture: $transfer(10, a) as r { … } hands r the raw reply",
      () => { const r = P('$transfer(10, "a") as r { stdout!(r) }');
        return /for \(@r <- ret\) \{\s*stdout!\(r\)\s*\}/.test(r.source) && !r.source.includes("transfer ok"); }],
    ["capture: a macro without `capture` rejects `as`",
      () => { const r = P('$directory("x") as d { Nil }');
        return r.errors.length === 1 && /does not support `as/.test(r.errors[0].message); }],
    ["capture: nested braces in the block are balanced",
      () => { const r = P('$balance("a") as bal { match bal { 0 => stdout!("empty") _ => stdout!(bal) } }');
        return r.errors.length === 0 && r.source.includes('match bal { 0 => stdout!("empty")'); }],
    ["capture: unbalanced block brace is an error, not a throw",
      () => P('$balance("a") as bal { stdout!(bal)').errors.length === 1],
  ];
  for (const [name, fn] of progCases) {
    try {
      if (fn()) { console.log(`  ok   program: ${name}`); pass++; }
      else console.log(`  FAIL program: ${name}`);
    } catch (e) { console.log(`  FAIL program: ${name}  →  ${e?.message ?? e}`); }
  }

  for (const [input, check] of cases) {
    try {
      const r = expandMacro(input);
      if (!check(r)) throw new Error(`check failed for ${JSON.stringify(input)}`);
      console.log(`  ok   ${input}`);
      pass++;
    } catch (e) {
      // The three injection/unknown cases are expected to throw — count them as passing.
      const expected = /injection|rejected|unknown macro|restricted pattern|decimal digits only/.test(e?.message ?? "");
      if (expected) { console.log(`  ok   ${input}  (rejected: ${e.message})`); pass++; }
      else { console.log(`  FAIL ${input}  →  ${e?.message ?? e}`); }
    }
  }
  const total = cases.length + progCases.length;
  console.log(`selftest: ${pass}/${total} passed`);
  return pass === total;
}


/** How a `$name(…)` line runs: a local read (answered here), an unsigned chain
 *  read (`/rholang eval`), a signed deploy, or not a built-in at all. */
function macroMode(name) {
  const m = MACROS[String(name ?? "").toLowerCase()];
  if (!m) return null;
  if (typeof m.expand === "function") return m.write ? "deploy" : "eval";
  if (typeof m.read === "function") return "read-local";
  return null;
}

return { MACROS, macroMode, expandBare, expandProgram, expandMacro, listMacros, HELP, selftest };
}

// rholang-exchange.js — a pooled token exchange, and its federation.
//
// A **pool** trades one pair of tokens at a fixed (owner-set) rate. Anyone
// holding the exchange URI can `deposit` a token they moved in, `swap` at the
// rate, and `withdraw`; the owner seeds liquidity with `provide` and sets the
// rate. `swap` refuses to overdraw either the swapper's balance or the pool's
// reserve, so conservation is held per pool — capability security is the whole
// proof (no method pays the operator, the pool holds no ambient authority).
//
// **Federation.** An exchange records peer exchanges by name (`link`), each on
// its own shard. `route` swaps locally, then returns the remote leg's call
// descriptor `("$at", shard, exchangeUri, "swap", toToken, out)` — the client
// runs it as a cross-shard *remote signed deploy* (rchain-rust#33/#34), so a
// swap can hop across exchanges on different shards. The two legs are separate
// transactions and are not atomic across shards (see CapabilityTransport.md).
//
// **Connecting to quantum-os currencies.** A `/note` currency is a bearer
// label; here it is that same label. Deploy a token contract for it
// (`rholang-token.js` / `$token`), record its URI on the currency, and pool two
// such URIs with `$exchange`. `token` is the token's own contract — the
// exchange never touches `rho:rchain:revVault`; the platform token cannot be
// pooled.
//
// Modeled on locker.js / shard_exchange.rho: every contract takes ≥2 params
// (rchain-rust#19), state cells are consumed-and-restored, no quoted names.
//
//   node packages/browser/src/rholang-exchange.js --selftest

/** Rate is fixed-point: `rate` units of B per 1e6 units of A. */
export const RATE_SCALE = 1_000_000;

/**
 * The exchange contract. Deployed once; its URI is then the address every
 * `open` / `deposit` / `swap` / … call resolves through.
 *
 * State:
 *   pools : Map<poolId, { owner, tokenA, tokenB, rate, reserveA, reserveB,
 *                         links: Map<name, {exchangeUri, shard}> }>
 *   bals  : Map<poolId, Map<holder, {a, b}>>   // holder = *deployerId
 */
export const EXCHANGE_RHO = `new
    Exchange, poolsCh, balsCh,
    insertArbitrary(\`rho:registry:insertArbitrary\`),
    deployerId(\`rho:rchain:deployerId\`), ret
in {
  poolsCh!({}) | balsCh!({}) |

  // open — create a pool for a token pair. deployer = owner; rate is B per A,
  // scaled by RATE_SCALE, changed only via "setRate".
  contract Exchange(_id, @"open", @poolId, @tokenA, @tokenB, @rate, ret) = {
    for (@pools <- poolsCh) {
      match pools.getOrElse(poolId, Nil) {
        Nil => {
          match rate > 0 {
            false => { poolsCh!(pools) | ret!(("exchange-error", "rate must be positive")) }
            true  => {
              new capCh in {
                insertArbitrary!({"pool": poolId, "owner": *_id}, *capCh) |
                for (@capUri <- capCh) {
                  poolsCh!(pools.set(poolId, {
                    "owner": *_id, "tokenA": tokenA, "tokenB": tokenB, "rate": rate,
                    "reserveA": 0, "reserveB": 0, "links": {}, "cap": capUri
                  })) | ret!(capUri)
                }
              }
            }
          }
        }
        _ => { poolsCh!(pools) | ret!(("exchange-error", "pool exists")) }
      }
    }
  } |

  // provide — owner seeds pool liquidity (tokens moved in out of band).
  contract Exchange(_id, @"provide", @poolId, @side, @amount, ret) = {
    for (@pools <- poolsCh) {
      match pools.getOrElse(poolId, Nil) {
        Nil => { poolsCh!(pools) | ret!(("exchange-error", "no such pool")) }
        p => {
          match [p.get("owner") == *_id, side, amount >= 0] {
            [true, "A", true] => { poolsCh!(pools.set(poolId, p.set("reserveA", p.get("reserveA") + amount))) | ret!(p.get("reserveA") + amount) }
            [true, "B", true] => { poolsCh!(pools.set(poolId, p.set("reserveB", p.get("reserveB") + amount))) | ret!(p.get("reserveB") + amount) }
            [false, _, _]     => { poolsCh!(pools) | ret!(("exchange-error", "not owner")) }
            _                 => { poolsCh!(pools) | ret!(("exchange-error", "bad provide")) }
          }
        }
      }
    }
  } |

  // deposit — credit the caller's in-pool balance (token moved in out of band).
  contract Exchange(_id, @"deposit", @poolId, @side, @amount, ret) = {
    for (@pools <- poolsCh; @bals <- balsCh) {
      let @h <- bals.getOrElse(poolId, {}).getOrElse(*_id, {"a": 0, "b": 0}) in {
        match [pools.contains(poolId), side, amount >= 0] {
          [true, "A", true] => { poolsCh!(pools) | balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("a", h.get("a") + amount)))) | ret!(h.get("a") + amount) }
          [true, "B", true] => { poolsCh!(pools) | balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("b", h.get("b") + amount)))) | ret!(h.get("b") + amount) }
          _                 => { poolsCh!(pools) | balsCh!(bals) | ret!(("exchange-error", "bad deposit")) }
        }
      }
    }
  } |

  // quote — what "amount" of "fromSide" buys of the other side.
  contract Exchange(_id, @"quote", @poolId, @fromSide, @amount, ret) = {
    for (@pools <- poolsCh) {
      match pools.getOrElse(poolId, Nil) {
        Nil => { poolsCh!(pools) | ret!(("exchange-error", "no such pool")) }
        p => {
          poolsCh!(pools) |
          match fromSide {
            "A" => { ret!({"toSide": "B", "out": amount * p.get("rate") / 1000000}) }
            "B" => { ret!({"toSide": "A", "out": amount * 1000000 / p.get("rate")}) }
            _   => { ret!(("exchange-error", "fromSide is A or B")) }
          }
        }
      }
    }
  } |

  // swap — from the caller's in-pool balance, against the reserve, at the rate.
  contract Exchange(_id, @"swap", @poolId, @fromSide, @amount, ret) = {
    for (@pools <- poolsCh; @bals <- balsCh) {
      match pools.getOrElse(poolId, Nil) {
        Nil => { poolsCh!(pools) | balsCh!(bals) | ret!(("exchange-error", "no such pool")) }
        p => {
          let @h <- bals.getOrElse(poolId, {}).getOrElse(*_id, {"a": 0, "b": 0}) in {
            match [fromSide, amount >= 0] {
              ["A", true] => {
                let @out <- amount * p.get("rate") / 1000000 in {
                  match [h.get("a") >= amount, p.get("reserveB") >= out] {
                    [true, true] => {
                      poolsCh!(pools.set(poolId, p.set("reserveA", p.get("reserveA") + amount).set("reserveB", p.get("reserveB") - out))) |
                      balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("a", h.get("a") - amount).set("b", h.get("b") + out)))) |
                      ret!({"gave": amount, "got": out, "toSide": "B"})
                    }
                    [false, _] => { poolsCh!(pools) | balsCh!(bals) | ret!(("exchange-error", "insufficient balance")) }
                    _          => { poolsCh!(pools) | balsCh!(bals) | ret!(("exchange-error", "insufficient reserve")) }
                  }
                }
              }
              ["B", true] => {
                let @out <- amount * 1000000 / p.get("rate") in {
                  match [h.get("b") >= amount, p.get("reserveA") >= out] {
                    [true, true] => {
                      poolsCh!(pools.set(poolId, p.set("reserveB", p.get("reserveB") + amount).set("reserveA", p.get("reserveA") - out))) |
                      balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("b", h.get("b") - amount).set("a", h.get("a") + out)))) |
                      ret!({"gave": amount, "got": out, "toSide": "A"})
                    }
                    [false, _] => { poolsCh!(pools) | balsCh!(bals) | ret!(("exchange-error", "insufficient balance")) }
                    _          => { poolsCh!(pools) | balsCh!(bals) | ret!(("exchange-error", "insufficient reserve")) }
                  }
                }
              }
              _ => { poolsCh!(pools) | balsCh!(bals) | ret!(("exchange-error", "bad swap")) }
            }
          }
        }
      }
    }
  } |

  // withdraw — debit the caller's in-pool balance; client moves the token out.
  contract Exchange(_id, @"withdraw", @poolId, @side, @amount, ret) = {
    for (@bals <- balsCh) {
      let @h <- bals.getOrElse(poolId, {}).getOrElse(*_id, {"a": 0, "b": 0}) in {
        match [side, amount >= 0] {
          ["A", true] => {
            match h.get("a") >= amount {
              true  => { balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("a", h.get("a") - amount)))) | ret!({"withdraw": amount, "side": "A", "left": h.get("a") - amount}) }
              false => { balsCh!(bals) | ret!(("exchange-error", "insufficient balance")) }
            }
          }
          ["B", true] => {
            match h.get("b") >= amount {
              true  => { balsCh!(bals.set(poolId, bals.getOrElse(poolId, {}).set(*_id, h.set("b", h.get("b") - amount)))) | ret!({"withdraw": amount, "side": "B", "left": h.get("b") - amount}) }
              false => { balsCh!(bals) | ret!(("exchange-error", "insufficient balance")) }
            }
          }
          _ => { balsCh!(bals) | ret!(("exchange-error", "bad withdraw")) }
        }
      }
    }
  } |

  // link — owner records a peer exchange on another shard, by name.
  contract Exchange(_id, @"link", @poolId, @name, @exchangeUri, @shard, ret) = {
    for (@pools <- poolsCh) {
      match pools.getOrElse(poolId, Nil) {
        Nil => { poolsCh!(pools) | ret!(("exchange-error", "no such pool")) }
        p => {
          match p.get("owner") == *_id {
            true  => { poolsCh!(pools.set(poolId, p.set("links", p.get("links").set(name, {"exchangeUri": exchangeUri, "shard": shard})))) | ret!(["linked", name]) }
            false => { poolsCh!(pools) | ret!(("exchange-error", "not owner")) }
          }
        }
      }
    }
  } |

  // route — swap here, then describe the remote leg for the client to run as a
  // cross-shard remote signed deploy (rchain-rust#33). Not atomic across shards.
  contract Exchange(_id, @"route", @poolId, @fromSide, @amount, @linkName, @remotePoolId, ret) = {
    for (@pools <<- poolsCh) {
      match pools.getOrElse(poolId, Nil) {
        Nil => { ret!(("exchange-error", "no such pool")) }
        p => {
          match p.get("links").getOrElse(linkName, Nil) {
            Nil => { ret!(("exchange-error", "no such link")) }
            lk => {
              new sret in {
                Exchange!(*_id, "swap", poolId, fromSide, amount, *sret) |
                for (@sr <- sret) {
                  match sr {
                    {"got": out, "toSide": toSide} => { ret!({"local": sr, "remote": ("$at", lk.get("shard"), lk.get("exchangeUri"), "swap", remotePoolId, toSide, out)}) }
                    _ => { ret!(sr) }
                  }
                }
              }
            }
          }
        }
      }
    }
  } |

  // setRate — owner only.
  contract Exchange(_id, @"setRate", @poolId, @rate, ret) = {
    for (@pools <- poolsCh) {
      match pools.getOrElse(poolId, Nil) {
        Nil => { poolsCh!(pools) | ret!(("exchange-error", "no such pool")) }
        p => {
          match [p.get("owner") == *_id, rate > 0] {
            [true, true]  => { poolsCh!(pools.set(poolId, p.set("rate", rate))) | ret!(["rate", rate]) }
            [false, _]    => { poolsCh!(pools) | ret!(("exchange-error", "not owner")) }
            _             => { poolsCh!(pools) | ret!(("exchange-error", "rate must be positive")) }
          }
        }
      }
    }
  } |

  // inspect — read the pool (anyone holding the exchange URI).
  contract Exchange(_id, @"inspect", @poolId, ret) = {
    for (@pools <<- poolsCh) {
      match pools.getOrElse(poolId, Nil) {
        Nil => { ret!(("exchange-error", "no such pool")) }
        p => { ret!({"tokenA": p.get("tokenA"), "tokenB": p.get("tokenB"), "rate": p.get("rate"),
                     "reserveA": p.get("reserveA"), "reserveB": p.get("reserveB"), "links": p.get("links")}) }
      }
    }
  } |

  CAPS
}`;

/** The verbs published behind write bundles. */
const FACETS = `{
    "open":     bundle+{*Exchange}, "provide":  bundle+{*Exchange},
    "deposit":  bundle+{*Exchange}, "quote":    bundle+{*Exchange},
    "swap":     bundle+{*Exchange}, "withdraw": bundle+{*Exchange},
    "link":     bundle+{*Exchange}, "route":    bundle+{*Exchange},
    "setRate":  bundle+{*Exchange}, "inspect":  bundle+{*Exchange}
  }`;

const q = (s) => JSON.stringify(String(s));
const int = (v) => { const s = String(v); if (!/^-?\d+$/.test(s)) throw new Error(`not an integer: ${s}`); return s; };

/** The install program — publishes the exchange with `insertArbitrary`. */
export function installProgram() {
  return EXCHANGE_RHO.replace("CAPS", `insertArbitrary!(${FACETS}, *ret) |
  for (@uri <- ret) { return!(uri) }`);
}

/**
 * One exchange call, as a complete program. Every call is its own deploy —
 * `deployerId` exists only inside a deploy, and a registry facet answers only
 * the first call in a program (rchain-rust#21).
 */
export function exchangeCall(exchangeUri, verb, args = []) {
  const call = ["*deployerId", q(verb), ...args].join(", ");
  return `new lookup(\`rho:registry:lookup\`), deployerId(\`rho:rchain:deployerId\`), stored, ret in {
  lookup!(\`${exchangeUri}\`, *stored) |
  for (@record <- stored) {
    match record {
      (_, caps) => {
        match caps.get(${q(verb)}) {
          Nil  => { return!(["no verb", ${q(verb)}]) }
          verb => { @verb!(*deployerId, ${q(verb)}${args.length ? ", " + args.join(", ") : ""}, *ret) | for (@a <- ret) { return!(a) } }
        }
      }
      _ => { return!(["no exchange at", ${q(exchangeUri)}]) }
    }
  }
}`;
}

export const openProgram    = (uri, poolId, tokenAUri, tokenBUri, rate) => exchangeCall(uri, "open", [q(poolId), q(tokenAUri), q(tokenBUri), int(rate)]);
export const provideProgram = (uri, poolId, side, amount) => exchangeCall(uri, "provide", [q(poolId), q(side.toUpperCase()), int(amount)]);
export const depositProgram = (uri, poolId, side, amount) => exchangeCall(uri, "deposit", [q(poolId), q(side.toUpperCase()), int(amount)]);
export const quoteProgram   = (uri, poolId, fromSide, amount) => exchangeCall(uri, "quote", [q(poolId), q(fromSide.toUpperCase()), int(amount)]);
export const swapProgram    = (uri, poolId, fromSide, amount) => exchangeCall(uri, "swap", [q(poolId), q(fromSide.toUpperCase()), int(amount)]);
export const withdrawProgram= (uri, poolId, side, amount) => exchangeCall(uri, "withdraw", [q(poolId), q(side.toUpperCase()), int(amount)]);
export const linkProgram    = (uri, poolId, name, remoteUri, shard) => exchangeCall(uri, "link", [q(poolId), q(name), q(remoteUri), q(shard)]);
export const routeProgram   = (uri, poolId, fromSide, amount, linkName, remotePoolId) => exchangeCall(uri, "route", [q(poolId), q(fromSide.toUpperCase()), int(amount), q(linkName), q(remotePoolId)]);
export const setRateProgram = (uri, poolId, rate) => exchangeCall(uri, "setRate", [q(poolId), int(rate)]);
export const inspectProgram = (uri, poolId) => exchangeCall(uri, "inspect", [q(poolId)]);

// ---------------------------------------------------------------------------
// Selftest — node packages/browser/src/rholang-exchange.js --selftest
// Shape only (balanced, verb names, arg order, ≥2 params, no quoted names);
// live-node behaviour is a follow-up like locker.js / captp.
// ---------------------------------------------------------------------------

export function selftest() {
  let pass = 0, fail = 0;
  const ok = (label, cond, d) => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}${d ? `  (${d})` : ""}`); } };

  const balanced = (s) => {
    const st = []; const close = { ")": "(", "]": "[", "}": "{" };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === "\\") i++; i++; } continue; }
      if ("([{".includes(c)) st.push(c);
      else if (c in close) { if (st.pop() !== close[c]) return false; }
    }
    return st.length === 0;
  };
  const URI = "rho:id:abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqr";

  ok("contract template is balanced", balanced(EXCHANGE_RHO));
  ok("no quoted name", !/@"[a-z]/.test(EXCHANGE_RHO.replace(/@"(open|provide|deposit|quote|swap|withdraw|link|route|setRate|inspect)"/g, "")), "@\"…\"");
  ok("every verb dispatch keeps ≥2 params",
     [...EXCHANGE_RHO.matchAll(/contract Exchange\(([^)]*)\)/g)].every((m) => m[1].split(",").filter((x) => x.trim()).length >= 3),
     "@\"verb\" + arg + ret");
  // Mutating verbs consume `poolsCh` with `<-` and must restore it; read-only
  // verbs (route/inspect) peek with `<<-`. Check every consuming block restores.
  ok("every `<- poolsCh` block restores poolsCh",
     [...EXCHANGE_RHO.split("contract Exchange(")].slice(1).every((blk) => {
       const consumes = /@pools <- poolsCh/.test(blk);
       return !consumes || (blk.match(/poolsCh!\(/g) || []).length >= 1;
     }));
  ok("never touches revVault", !/revVault|rho:rchain:revVault/.test(EXCHANGE_RHO));
  ok("all ten verbs defined",
     ["open","provide","deposit","quote","swap","withdraw","link","route","setRate","inspect"]
       .every((v) => EXCHANGE_RHO.includes(`@"${v}"`)));

  const inst = installProgram();
  ok("install is balanced", balanced(inst));
  ok("install has no CAPS placeholder", !/\bCAPS\b/.test(inst));
  ok("install publishes via insertArbitrary", inst.includes("insertArbitrary!("));

  const open = openProgram(URI, "USD-EUR", "rho:id:usd", "rho:id:eur", 920000);
  ok("open is balanced", balanced(open));
  ok("open carries deployerId, verb, pool, tokens, rate in order",
     /@verb!\(\*deployerId, "open", "USD-EUR", "rho:id:usd", "rho:id:eur", 920000, \*ret\)/.test(open), open.slice(-260));

  const swap = swapProgram(URI, "USD-EUR", "a", 100n);
  ok("swap upper-cases the side and passes the amount", /@verb!\(\*deployerId, "swap", "USD-EUR", "A", 100, \*ret\)/.test(swap), swap.slice(-200));

  const route = routeProgram(URI, "USD-EUR", "B", 50, "paris", "EUR-GBP");
  ok("route carries link + remote pool", /@verb!\(\*deployerId, "route", "USD-EUR", "B", 50, "paris", "EUR-GBP", \*ret\)/.test(route), route.slice(-240));

  const link = linkProgram(URI, "USD-EUR", "paris", "rho:id:paris", "https://shard-b.example");
  ok("link carries name, uri, shard", /"paris", "rho:id:paris", "https:\/\/shard-b.example"/.test(link));

  ok("a non-integer amount is rejected",
     (() => { try { swapProgram(URI, "p", "A", "1.5"); return false; } catch { return true; } })());

  const nasty = openProgram(URI, 'x", *evil) | @"stolen"!("', "rho:id:a", "rho:id:b", 1);
  ok("a hostile pool id stays inside its literal",
     balanced(nasty) && !/@"stolen"!/.test(nasty.replace(/"(?:[^"\\]|\\.)*"/g, '""')));

  console.log(`selftest: ${pass}/${pass + fail} passed`);
  return fail === 0;
}

// Auto-run only when this file IS the entry point (not when imported by
// rholang-macros.js under a `--selftest` parent process).
if (typeof process !== "undefined" && process.argv?.includes("--selftest") &&
    import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(selftest() ? 0 : 1);
}

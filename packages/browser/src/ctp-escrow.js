// ctp-escrow.js — the cross-shard transport escrow, one per shard.
//
// A bridge (a dual-shard account, see CapabilityTransport.md) moves value
// between two shards by locking on the source and minting on the destination.
// This is the rholang half: a stateful contract deployed once per shard by the
// bridge account, reached thereafter at its registry uri. Every verb takes a
// `deployerId`, which rnode issues only to the deploy that signed for it — so
// the privileged verbs (`register`, `refund`) are gated by an owner captured at
// install, and `lock` debits exactly the caller's vault.
//
// Modeled on locker.js, and the same two shape rules apply:
//   1. Every contract takes at least two parameters (a one-binder persistent
//      receive in a nested `new` runs away — rchain-rust#19).
//   2. Readers consume and restore the state cell (`for (@s <- st) { st!(s) | … }`).
//
// TIER 1 (this contract). The in-transit amount sits in the bridge account's
// own vault (`poolAddr`) on the source shard from the moment of `lock`; `refund`
// is owner-gated. So a bridge operator is trusted for good faith, with the
// social deterrent (`/gov censure`, the room's audit trail, `lockOf` for
// independent verification) rather than an on-chain guarantee. The trustless
// path — distinct per-shard keys + a secp256k1 attestation quorum, or an M-of-N
// multisig escrow — is Tier 2, built when a bridge's value justifies it.
//
// Three levels of check:
//   * shape — `node packages/browser/src/ctp-escrow.js --selftest` (in CI):
//     balanced, verb names, arg positions, ≥2 params, no quoted names.
//   * behaviour — `node scripts/localnet/ctp-escrow-check.mjs` against a live
//     rnode: the contract parses and reduces, every verb returns what its help
//     says (with `revVault` stubbed).
//   * end to end — `node scripts/localnet/ctp-e2e.mjs`: REAL signed deploys with
//     genesis-funded keys — install both escrows, register, a funded `lock` and
//     `mint`, and the recipient's REV balance moves by the transfer amount.
//     Verified on bin/rnode 0.1.0.

/**
 * The escrow contract. Deployed once per shard; its uri is then the address the
 * bridge account uses for every `lock` / `mint` / `refund` on that shard.
 *
 * State, seeded at install and thereafter consumed-and-restored by every verb:
 *
 *   { "owner":        *deployerId    // the installer — gates register / refund
 *   , "poolAddr":     <rev address>  // the bridge account's vault on THIS shard
 *   , "shardId":      <string>       // this shard's id, stamped into burn receipts
 *   , "counterparts": Set(<shardId>) // shards this escrow will accept a mint from
 *   , "locks":        { nonce: {subject, amount, destAddr, status} }
 *   , "minted":       { nonce: <mint receipt> } }   // dedupe on the mint side
 */
export const CTP_ESCROW_RHO = `new st,
    doRegister, doLock, doMint, doRefund, doLockOf, doInfo,
    revVault(\`rho:rchain:revVault\`),
    insertArbitrary(\`rho:registry:insertArbitrary\`),
    deployerId(\`rho:rchain:deployerId\`), ret
in {
  st!({
    "owner": *deployerId, "poolAddr": POOL, "shardId": SHARD,
    "counterparts": Set(), "locks": {}, "minted": {}
  }) |

  // Accept mints originating from another shard. Owner only: the counterpart
  // list is the whole of who this escrow trusts to have burned value.
  contract doRegister(@id, @counterpartShardId, ret) = {
    for (@s <- st) {
      if (s.get("owner") == id) {
        st!(s.set("counterparts", s.get("counterparts").union(Set(counterpartShardId)))) |
        ret!(["registered", counterpartShardId])
      } else { st!(s) | ret!(["denied", "owner only"]) }
    }
  } |

  // Lock value on the source shard. The caller's vault is debited to the bridge
  // pool; a burn receipt is recorded under \`nonce\` and returned. A reused nonce
  // is refused before any transfer. \`subjectAddr\` is the caller's own REV
  // address, carried in the receipt (a deployerId is an unforgeable name and
  // cannot be serialised) and used as the refund target.
  contract doLock(@id, @subjectAddr, @amount, @destAddr, @nonce, ret) = {
    for (@s <- st) {
      if (s.get("locks").contains(nonce)) { st!(s) | ret!(["dup nonce", nonce]) }
      else {
        new ack in {
          revVault!("transfer", id, s.get("poolAddr"), amount, *ack) |
          for (@a <- ack) {
            match a {
              Nil => {
                st!(s.set("locks", s.get("locks").set(nonce,
                  {"subject": subjectAddr, "amount": amount, "destAddr": destAddr, "status": "locked"}))) |
                ret!(("ctp-burn", s.get("shardId"), subjectAddr, amount, nonce, destAddr))
              }
              _ => { st!(s) | ret!(["transfer failed", a]) }
            }
          }
        }
      }
    }
  } |

  // Mint on the destination shard against a burn receipt relayed from the
  // source. Owner only (the mint is paid from the bridge pool on this shard).
  // Idempotent by nonce: a receipt already seen returns the prior mint receipt
  // and pays nothing.
  contract doMint(@id, @burnReceipt, ret) = {
    for (@s <- st) {
      if (s.get("owner") != id) { st!(s) | ret!(["denied", "owner only"]) }
      else {
        match burnReceipt {
          ("ctp-burn", srcShard, subject, amount, nonce, destAddr) => {
            if (s.get("minted").contains(nonce)) { st!(s) | ret!(s.get("minted").get(nonce)) }
            else {
              if (s.get("counterparts").contains(srcShard)) {
                new ack in {
                  revVault!("transfer", id, destAddr, amount, *ack) |
                  for (@a <- ack) {
                    match a {
                      Nil => {
                        new mr in {
                          mr!(("ctp-mint", s.get("shardId"), destAddr, amount, nonce, srcShard)) |
                          for (@receipt <- mr) {
                            st!(s.set("minted", s.get("minted").set(nonce, receipt))) |
                            ret!(receipt)
                          }
                        }
                      }
                      _ => { st!(s) | ret!(["transfer failed", a]) }
                    }
                  }
                }
              } else { st!(s) | ret!(["unknown counterpart", srcShard]) }
            }
          }
          _ => { st!(s) | ret!(["bad burn receipt"]) }
        }
      }
    }
  } |

  // Reverse an un-minted lock on the source shard. Owner only: the pool pays
  // the original subject back.
  contract doRefund(@id, @nonce, ret) = {
    for (@s <- st) {
      if (s.get("owner") != id) { st!(s) | ret!(["denied", "owner only"]) }
      else {
        match s.get("locks").getOrElse(nonce, Nil) {
          Nil => { st!(s) | ret!(["no such lock", nonce]) }
          lock => {
            if (lock.get("status") == "locked") {
              new ack in {
                revVault!("transfer", id, lock.get("subject"), lock.get("amount"), *ack) |
                for (@a <- ack) {
                  match a {
                    Nil => {
                      st!(s.set("locks", s.get("locks").set(nonce, lock.set("status", "refunded")))) |
                      ret!(["refunded", nonce, lock.get("amount")])
                    }
                    _ => { st!(s) | ret!(["transfer failed", a]) }
                  }
                }
              }
            } else { st!(s) | ret!(["not refundable", lock.get("status")]) }
          }
        }
      }
    }
  } |

  // Read a lock by nonce — so a counterpart operator or an auditor can verify a
  // burn receipt against the source shard independently. No identity needed.
  contract doLockOf(@nonce, ret) = {
    for (@s <- st) { st!(s) | ret!(s.get("locks").getOrElse(nonce, Nil)) }
  } |

  // Read the escrow's public facts: its shard id, its pool address, and the
  // shards it accepts mints from. Not the lock map (unbounded).
  contract doInfo(@_unused, ret) = {
    for (@s <- st) {
      st!(s) |
      ret!({"shardId": s.get("shardId"), "poolAddr": s.get("poolAddr"),
            "counterparts": s.get("counterparts")})
    }
  } |

  CAPS
}`;

/** The facet map — every verb as an unforgeable name behind a write bundle. */
const FACETS = `{
    "register": bundle+{*doRegister}, "lock":   bundle+{*doLock},
    "mint":     bundle+{*doMint},     "refund": bundle+{*doRefund},
    "lockOf":   bundle+{*doLockOf},   "info":   bundle+{*doInfo}
  }`;

/** A rholang string literal (JSON.stringify produces one). */
const q = (s) => JSON.stringify(String(s));

/**
 * The install program — a signed deploy the bridge account submits to put its
 * escrow on this shard. Published with `insertArbitrary`, so the uri is
 * unpredictable and learned from what the deploy answers (like the locker;
 * `insertSigned` would collide with the deploy-result slot).
 *
 * @param {string} poolAddr  the bridge account's REV address on this shard
 * @param {string} shardId   this shard's id (stamped into burn receipts)
 */
export function installProgram(poolAddr, shardId) {
  return CTP_ESCROW_RHO
    .replace("POOL", q(poolAddr))
    .replace("SHARD", q(shardId))
    .replace("CAPS", `insertArbitrary!(${FACETS}, *ret) |
  for (@uri <- ret) { return!(uri) }`);
}

/**
 * One escrow call, as a complete program. Every call is its own deploy —
 * `deployerId` exists only inside a deploy, and a registry facet answers only
 * the first call in a program (rchain-rust#21), so a verb per program is both
 * necessary and sufficient.
 *
 * @param {string} escrowUri  where the escrow was published
 * @param {string} verb       register | lock | mint | refund | lockOf | info
 * @param {string[]} args     rholang terms, already quoted where strings
 * @param {boolean} withId     pass `*deployerId` as the first argument
 */
export function escrowCall(escrowUri, verb, args = [], withId = true) {
  const head = withId ? ["*deployerId", ...args] : args;
  const call = head.join(", ");
  return `new lookup(\`rho:registry:lookup\`), deployerId(\`rho:rchain:deployerId\`), stored, ret in {
  lookup!(\`${escrowUri}\`, *stored) |
  for (@record <- stored) {
    match record {
      (_, caps) => {
        match caps.get(${q(verb)}) {
          Nil  => { return!(["no verb", ${q(verb)}]) }
          verb => {
            @verb!(${call}, *ret) |
            for (@answer <- ret) { return!(answer) }
          }
        }
      }
      _ => { return!(["no escrow at", ${q(escrowUri)}]) }
    }
  }
}`;
}

/** Trust a counterpart shard's burn receipts (owner only). */
export function registerProgram(escrowUri, counterpartShardId) {
  return escrowCall(escrowUri, "register", [q(counterpartShardId)]);
}

/**
 * Lock `amount` REV for `destAddr` on the far shard, keyed by `nonce`.
 * `subjectAddr` is the caller's own REV address (carried in the burn receipt,
 * and the refund target) — a `deployerId` cannot be serialised.
 */
export function lockProgram(escrowUri, subjectAddr, amount, destAddr, nonce) {
  return escrowCall(escrowUri, "lock", [q(subjectAddr), String(amount), q(destAddr), q(nonce)]);
}

/**
 * Mint against a burn receipt relayed from the source shard (owner only).
 * `burnReceiptTerm` is the rholang tuple `("ctp-burn", …)` as text.
 */
export function mintProgram(escrowUri, burnReceiptTerm) {
  return escrowCall(escrowUri, "mint", [String(burnReceiptTerm)]);
}

/** Reverse an un-minted lock (owner only). */
export function refundProgram(escrowUri, nonce) {
  return escrowCall(escrowUri, "refund", [q(nonce)]);
}

/** Read a lock by nonce — for independent verification of a burn receipt. */
export function lockOfProgram(escrowUri, nonce) {
  return escrowCall(escrowUri, "lockOf", [q(nonce)], false);
}

/** Read the escrow's public facts (shard id, pool address, counterparts). */
export function infoProgram(escrowUri) {
  return escrowCall(escrowUri, "info", ["Nil"], false);
}

// ---------------------------------------------------------------------------
// Selftest — node packages/browser/src/ctp-escrow.js --selftest
//
// The contract is exercised against a live rnode elsewhere (issue #173). What
// this checks is the half that ships: every program is well-formed, names the
// right verb, and cannot be made to carry an argument out of position.
// ---------------------------------------------------------------------------

export function selftest() {
  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`); }
  };

  const balanced = (s) => {
    const st = [];
    const close = { ")": "(", "]": "[", "}": "{" };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === "\\") i++; i++; } continue; }
      if ("([{".includes(c)) st.push(c);
      else if (c in close) { if (st.pop() !== close[c]) return false; }
    }
    return st.length === 0;
  };

  const URI = "rho:id:abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqr";

  ok("the contract template is delimiter-balanced", balanced(CTP_ESCROW_RHO));
  ok("the contract quotes no name", !/@"/.test(CTP_ESCROW_RHO), "@\"…\" — see SECURITY.md");
  ok("every contract takes at least two parameters",
     [...CTP_ESCROW_RHO.matchAll(/contract\s+\w+\(([^)]*)\)/g)]
       .every((m) => m[1].split(",").filter((x) => x.trim()).length >= 2),
     "a one-binder persistent receive in a nested new runs away — rchain-rust#19");
  ok("readers consume and restore, never peek", !/<<-/.test(CTP_ESCROW_RHO));
  ok("all six verbs are defined",
     ["doRegister", "doLock", "doMint", "doRefund", "doLockOf", "doInfo"]
       .every((v) => CTP_ESCROW_RHO.includes(`contract ${v}(`)));

  const install = installProgram("11112pooladdr", "root");
  ok("install is well-formed", balanced(install));
  ok("install seeds the owner from *deployerId", install.includes('"owner": *deployerId'));
  ok("install substitutes the pool address as a literal", install.includes('"poolAddr": "11112pooladdr"'));
  ok("install substitutes the shard id as a literal", install.includes('"shardId": "root"'));
  ok("install has no unsubstituted placeholder", !/\b(POOL|SHARD|CAPS)\b/.test(install));
  ok("install publishes with insertArbitrary", install.includes("insertArbitrary!("));
  ok("install returns the uri", /for \(@uri <- ret\) \{ return!\(uri\) \}/.test(install));

  const reg = registerProgram(URI, "root/child");
  ok("register is well-formed", balanced(reg));
  ok("register passes deployerId then the counterpart", /@verb!\(\*deployerId, "root\/child", \*ret\)/.test(reg), reg.slice(-260));
  ok("register names the register facet", reg.includes('caps.get("register")'));
  ok("a call unwraps what lookup answers with", /match record \{\s*\(_, caps\)/.test(reg));

  const lock = lockProgram(URI, "1111alice", 30n, "1111bob", "n-abc123");
  ok("lock is well-formed", balanced(lock));
  ok("lock carries subject, amount, dest, nonce in order",
     /@verb!\(\*deployerId, "1111alice", 30, "1111bob", "n-abc123", \*ret\)/.test(lock), lock.slice(-300));

  const mint = mintProgram(URI, '("ctp-burn", "root", "1111alice", 30, "n-abc123", "1111bob")');
  ok("mint is well-formed", balanced(mint));
  ok("mint passes deployerId then the burn-receipt tuple",
     /@verb!\(\*deployerId, \("ctp-burn", "root", "1111alice", 30, "n-abc123", "1111bob"\), \*ret\)/.test(mint), mint.slice(-360));

  const refund = refundProgram(URI, "n-abc123");
  ok("refund carries only the nonce after the id", /@verb!\(\*deployerId, "n-abc123", \*ret\)/.test(refund), refund.slice(-220));

  const lockOf = lockOfProgram(URI, "n-abc123");
  ok("lockOf is well-formed", balanced(lockOf));
  ok("lockOf passes no deployerId (a read)", /@verb!\("n-abc123", \*ret\)/.test(lockOf), lockOf.slice(-200));

  const info = infoProgram(URI);
  ok("info passes Nil, no deployerId", /@verb!\(Nil, \*ret\)/.test(info), info.slice(-200));

  // A hostile nonce cannot escape its string literal.
  const nasty = lockProgram(URI, "1111alice", 1n, "1111bob", 'x", *evil) | @"stolen"!("');
  ok("a hostile nonce stays inside its literal",
     balanced(nasty) && !/@"stolen"!/.test(nasty.replace(/"(?:[^"\\]|\\.)*"/g, '""')), nasty);

  ok("no quoted name in any program",
     [install, reg, lock, mint, refund, lockOf, info].every((p) => !/@"/.test(p)));

  console.log(`selftest: ${pass}/${pass + fail} passed`);
  return fail === 0;
}

if (typeof process !== "undefined" && process.argv && process.argv.includes("--selftest")) {
  process.exit(selftest() ? 0 : 1);
}

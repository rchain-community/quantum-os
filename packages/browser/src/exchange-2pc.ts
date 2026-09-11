/// The client-side half of the atomic cross-shard exchange (rholang-exchange.js
/// prepare/prepareReceive/commit/abort/stateOf). The contracts carry the
/// authoritative state; this module is the pure decision logic a client (or a
/// crashed client's later reconnect) uses to drive and recover a trade — no
/// network calls here, so it's directly testable.
///
/// The protocol, in five calls:
///   1. prepare        on the local pool  (own deploy)
///   2. prepareReceive on the linked remote pool (Layer-1 remote signed deploy,
///      same key — a deployerId is shard-independent)
///   3a. both prepared  → commit local, commit remote
///   3b. either refused → abort whichever leg actually prepared
///
/// Both legs are gated to the SAME identity throughout (this trader's own
/// key runs prepare AND prepareReceive), so recovery after a crashed client
/// needs no counterparty coordination: reconnect with the same key, read
/// stateOf on both legs, and `decideRecovery` says what is left to do.
///
/// Known gap (see rholang-exchange.js and CapabilityTransport.md): `abort`
/// is self-only in this version — there is no on-chain permissionless
/// timeout, because reading rho:block:data from a signed deploy breaks this
/// rnode build's return-value readback (verified empirically). So a trade
/// abandoned by its own key stays "prepared" — locked, not lost — until that
/// key reappears and runs the recovery decision below.

/** A tx leg's status, as read from `stateOf`. "unknown" covers both a txId
 *  that was never prepared and one whose exchange couldn't be reached. */
export type TxLegStatus = "unknown" | "prepared" | "committed" | "aborted";

/** What to do next, given both legs' current status. */
export type RecoveryAction =
  | "commit-both"     // both prepared — finish the trade
  | "commit-local"    // remote already committed; finish the local leg
  | "commit-remote"   // local already committed; finish the remote leg
  | "abort-local"     // remote never prepared, or remote aborted — unwind local
  | "abort-remote"    // local aborted — unwind the remote credit
  | "noop"            // already fully settled (both committed, or both aborted/never happened)
  | "inconsistent";   // one leg committed while the other aborted (or never
                       // prepared) — a client that committed local before
                       // confirming remote prepared; not reachable by
                       // following the protocol in order. Surface, don't guess.

/**
 * The recovery decision table. `local` is this pool's own leg (the one
 * `prepare` was called on); `remote` is the linked pool's leg
 * (`prepareReceive`). Pure — same inputs, same answer, on any peer running
 * the recovery with the same key.
 */
export function decideRecovery(local: TxLegStatus, remote: TxLegStatus): RecoveryAction {
  switch (local) {
    case "prepared":
      switch (remote) {
        case "unknown": return "abort-local";
        case "prepared": return "commit-both";
        case "committed": return "commit-local";
        case "aborted": return "abort-local";
      }
      break;
    case "committed":
      switch (remote) {
        case "unknown": return "inconsistent";
        case "prepared": return "commit-remote";
        case "committed": return "noop";
        case "aborted": return "inconsistent";
      }
      break;
    case "aborted":
      switch (remote) {
        case "unknown": return "noop";
        case "prepared": return "abort-remote";
        case "committed": return "inconsistent";
        case "aborted": return "noop";
      }
      break;
    case "unknown":
      // The local leg is always this client's own prepare call — if it
      // shows "unknown" there is no tx to recover.
      return "noop";
  }
  return "inconsistent";
}

/** A fresh, opaque transaction id — the client picks it and it correlates
 *  the two legs. Not a capability, not secret; collision-resistant enough
 *  for one client's own sequence of trades. */
export function makeTxId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A cross-shard trade's plan — everything the client needs to run the five
 *  calls and, if interrupted, resume from `decideRecovery`. */
export interface CrossShardTrade {
  txId: string;
  localExchangeUri: string;
  localPoolId: string;
  fromSide: "A" | "B";
  amount: bigint | number;
  expiryBlock: number;
  linkName: string;      // the local pool's link entry naming the remote pool
  remoteExchangeUri: string;
  remotePoolId: string;
}

/** One outcome of running (or recovering) a trade. */
export interface TradeOutcome {
  txId: string;
  local: TxLegStatus;
  remote: TxLegStatus;
  action: RecoveryAction;
  /** Set once both legs are known to be in the same terminal state. */
  settled: boolean;
}

/** Fold a freshly-read pair of leg statuses into an outcome — the pure part
 *  of "check where a trade stands and what, if anything, is left to do." */
export function evaluateTrade(txId: string, local: TxLegStatus, remote: TxLegStatus): TradeOutcome {
  const action = decideRecovery(local, remote);
  const settled = action === "noop" || action === "inconsistent";
  return { txId, local, remote, action, settled };
}

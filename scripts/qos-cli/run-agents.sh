#!/usr/bin/env bash
# Launch QuantumOS room agents DETACHED, on your Claude subscription (claude-code
# backend — needs the `claude` CLI installed + logged in). Because they're nohup'd,
# they keep running after you close the terminal (use tmux/screen or a service for
# survival across logout/reboot).
#
#   bash run-agents.sh [room-cap-or-url] [role ...]
#
# Defaults: the public room + facilitator alone. Stable identity per role under
# ./.qos-<role>; logs + pids under ./.agents. Stop with ./stop-agents.sh.
#
# HOW MANY AGENTS
#
# The room is a full mesh (peer.ts / qospeer.mjs) — every peer holds a direct
# data channel to every other, and a browser sustains ~15 of them comfortably.
# Every agent spends one of those slots and one connection budget per other
# peer, so the default is ONE agent: the facilitator, which carries the
# superset of the role duties (greet, name-prompt, synthesise, chair) and the
# room's memory via --persist.
#
# Add roles only when you need them:
#   bash run-agents.sh "$ROOM" facilitator skeptic
# `skeptic` is the only role that runs `verify` — flagging a history that
# passes the room's aggregate predicate but fails QLF's pairwise one — so add
# it when that matters. `scribe`'s duties are a strict subset of the
# facilitator's, so it is never worth a separate peer.
#
# The `/rholang` macro agent is NOT started here — the browser expands locally,
# so the agent is only worth a peer when you want the expansion posted into chat
# for the room to read. Start it by hand if you do:
#   node rholang-agent.mjs --room <cap> --name rholang
#
set -euo pipefail
cd "$(dirname "$0")"

ROOM="${1:-cap:room:05214747236101414325074505234721}"
shift || true
# Default role: facilitator alone — it greets newcomers ("hi"), requests a name,
# synthesises and chairs, and carries the room's memory. Pass roles explicitly
# to add more, e.g. `bash run-agents.sh "$ROOM" facilitator skeptic`.
ROLES=("$@"); [ ${#ROLES[@]} -eq 0 ] && ROLES=(facilitator)

# The room's memory rides with the FIRST role rather than running as its own
# peer. Same duty qos-daemon.mjs performs alone — which still works standalone,
# see the README — but carried here it costs no peer against the ceiling above.
# NO_MEMORY=1 turns it off; PERSIST_DIR moves the store.
PERSIST_DIR="${PERSIST_DIR:-./.qos-memory}"

# Seconds between joins. Override with STAGGER=n for a slower link or a bigger cast.
STAGGER="${STAGGER:-15}"

command -v node >/dev/null || { echo "node not found — install Node 18+."; exit 1; }
[ -d node_modules ] || { echo "Run 'npm install' in scripts/qos-cli first."; exit 1; }
command -v claude >/dev/null || echo "warning: 'claude' CLI not on PATH — the claude-code AI backend needs it (agents still run, deterministically)."

mkdir -p .agents
for role in "${ROLES[@]}"; do
  pidf=".agents/$role.pid"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
    echo "• $role already running (pid $(cat "$pidf"))"; continue
  fi
  persist=()
  if [ -z "${NO_MEMORY:-}" ] && [ "$role" = "${ROLES[0]}" ]; then persist=(--persist "$PERSIST_DIR"); fi
  nohup node agent.mjs --room "$ROOM" --role "$role" --ai --ai-backend claude-code \
    --state "./.qos-$role" "${persist[@]}" >> ".agents/$role.log" 2>&1 &
  echo $! > "$pidf"
  echo "✓ started $role (pid $!) → scripts/qos-cli/.agents/$role.log"
  sleep "$STAGGER"   # keep joins off each other's heels; see the ceiling note above
done


echo
echo "Tail:  tail -f scripts/qos-cli/.agents/*.log"
echo "Stop:  bash scripts/qos-cli/stop-agents.sh"

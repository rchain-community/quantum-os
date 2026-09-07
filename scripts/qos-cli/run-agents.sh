#!/usr/bin/env bash
# Launch QuantumOS room agents DETACHED, on your Claude subscription (claude-code
# backend — needs the `claude` CLI installed + logged in). Because they're nohup'd,
# they keep running after you close the terminal (use tmux/screen or a service for
# survival across logout/reboot).
#
#   bash run-agents.sh [room-cap-or-url] [role ...]
#
# Defaults: the public room + facilitator. Stable identity per role under
# ./.qos-<role>; logs + pids under ./.agents. Stop with ./stop-agents.sh.
#
# HOW MANY AGENTS, AND WHY THE STAGGER
#
# A peer joining a room of N sends N-1 offers and then a burst of ICE candidates,
# so the per-connection signaling rate during a join is superlinear in room size.
# The signaling server caps that rate per connection (SIGNAL_RATE_LIMIT, set to
# 200/s for the public deployment in render.yaml); over the cap, handshakes stop
# completing while every peer still appears in the room — from a browser that is
# indistinguishable from the other peers never having arrived. The roster marks
# a peer it has no data channel to, so the failure is visible where the peer is.
#
# The stagger keeps a set of agents from arriving as one burst, which is the
# shape that costs the most rate for the least reason.
#
# The defaults are facilitator + skeptic, with the room's memory carried by the
# first of them rather than run as its own peer.
#
# `scribe` is not among them because it needs no peer of its own: its duties are
# a strict subset of the facilitator's (see agent-roles.mjs), so a facilitator
# already does everything a scribe does, and carrying --persist it is literally
# the one keeping the record. `skeptic` is separate because it is the only role
# that verifies — which predicate a history actually passed — and nothing else
# does that.
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
# Default role: facilitator greets newcomers ("hi") and requests a name itself, so
# no separate greeter is needed. Pass roles explicitly to override, e.g.
#   bash run-agents.sh "$ROOM" facilitator scribe
# — see the ceiling note above before adding several.
ROLES=("$@"); [ ${#ROLES[@]} -eq 0 ] && ROLES=(facilitator skeptic)

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

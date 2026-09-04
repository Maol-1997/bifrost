#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
  printf 'Usage: npm run worktree -- init <slot 1-999> | up | dev | status | down | run <command...>\n' >&2
  exit 2
}

command=${1:-}
[[ $# -gt 0 ]] || usage
shift
if [[ "$command" == init ]]; then
  [[ $# == 1 && "$1" =~ ^[1-9][0-9]{0,2}$ ]] || usage
  [[ ! -e .worktree/env ]] || { printf 'Already initialized; refusing to replace the encryption key or ports.\n' >&2; exit 1; }
  slot=$1
  umask 077
  mkdir -p .worktree
  project_hash=$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.cwd()).digest("hex").slice(0,12))')
  encryption_key=$(openssl rand -base64 32)
  cat > .worktree/env <<ENV
COMPOSE_PROJECT_NAME=bifrost-wt-$project_hash
WORKTREE_POSTGRES_PORT=$((15000 + slot))
WORKTREE_REDIS_PORT=$((17000 + slot))
PORT=$((3000 + slot))
VITE_PORT=$((5000 + slot))
PUBLIC_URL=http://localhost:$((3000 + slot))
DATABASE_URL=postgres://bifrost:bifrost@127.0.0.1:$((15000 + slot))/bifrost
REDIS_URL=redis://127.0.0.1:$((17000 + slot))/0
ENCRYPTION_KEY=$encryption_key
ENV
  printf 'Initialized slot %s. Next: npm run worktree -- dev\n' "$slot"
  exit 0
fi
[[ -f .worktree/env ]] || { printf 'Run npm run worktree -- init <unique-slot> first.\n' >&2; exit 1; }
set -a
source .worktree/env
set +a
compose=(docker compose --env-file .worktree/env --project-name "$COMPOSE_PROJECT_NAME" -f scripts/compose.worktree.yml)
case "$command" in
  up) "${compose[@]}" up -d --wait ;;
  dev)
    "${compose[@]}" up -d --wait
    npm run migrate
    exec ./node_modules/.bin/concurrently --names server,client --prefix-colors cyan,magenta --kill-others npm:dev:server npm:dev:client
    ;;
  status)
    printf 'API: %s  UI: http://localhost:%s  Project: %s\n' "$PUBLIC_URL" "$VITE_PORT" "$COMPOSE_PROJECT_NAME"
    "${compose[@]}" ps
    ;;
  down) "${compose[@]}" down ;;
  run) [[ $# -gt 0 ]] || usage; exec "$@" ;;
  *) usage ;;
esac

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
  printf 'Usage: npm run integration -- up | test | bench [benchmark options...] | down\n' >&2
  exit 2
}

# Loopback ports from test/integration/compose.yaml; an explicit environment wins.
export TEST_DATABASE_URL=${TEST_DATABASE_URL:-postgres://bifrost:bifrost@127.0.0.1:25433/bifrost_test}
export TEST_REDIS_URL=${TEST_REDIS_URL:-redis://127.0.0.1:26380}
compose=(docker compose -f test/integration/compose.yaml)

command=${1:-}
[[ $# -gt 0 ]] || usage
shift
case "$command" in
  up) "${compose[@]}" up -d --wait ;;
  test) "${compose[@]}" up -d --wait && npm run test:integration ;;
  bench) "${compose[@]}" up -d --wait && npm run bench:load -- "$@" ;;
  down) "${compose[@]}" down ;;
  *) usage ;;
esac

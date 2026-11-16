#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."

# Integration tests need Postgres and Redis. CI always provides them; locally
# the stage is skipped, visibly, unless both URLs are set.
stages=(lint format:check typecheck test)
if [[ -n "${TEST_DATABASE_URL:-}" && -n "${TEST_REDIS_URL:-}" ]]; then
  stages+=(test:integration)
fi
stages+=(build)

summary=()
for stage in "${stages[@]}"; do
  printf '\n=== %s ===\n' "$stage"
  if npm run "$stage"; then
    summary+=("PASS $stage")
  else
    summary+=("FAIL $stage")
    printf '\nVerification failed (remaining stages not run):\n'
    printf '  %s\n' "${summary[@]}"
    exit 1
  fi
done
if [[ ! " ${stages[*]} " =~ " test:integration " ]]; then
  summary+=("SKIP test:integration (set TEST_DATABASE_URL and TEST_REDIS_URL, or run: npm run integration -- test)")
fi
printf '\nVerification passed:\n'
printf '  %s\n' "${summary[@]}"
printf 'The browser tier is not implemented; this is not end-to-end UI proof.\n'

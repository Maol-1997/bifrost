#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."

summary=()
for stage in lint typecheck test build; do
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
printf '\nVerification passed:\n'
printf '  %s\n' "${summary[@]}"
printf 'Integration/browser tiers are not implemented; this is not end-to-end proof.\n'

# Performance audit — 2026-09-04

Worktree: `audit/perf`, based on `673eb31`. Changes are behavior-preserving:
policy filtering remains on the request path, full review data remains available,
and no credential lifetime or provider behavior changed.

## Implemented

1. **Memoize the validated discovery entry, not just its normalized tools.**
   Warm exact-byte hits avoid JSON.parse and Zod validation while retaining every
   backend read, generation check, expiry check, user/provider key and existing
   256-entry bound. Four regression tests exercise warm-cache replacement,
   corruption, expiry and another worker's invalidation.
2. **Read only policy decision fields for assembly/execution.**
   The new store method projects tool name, fingerprint and state. Full JSONB
   contract snapshots are still fetched by the existing review API. Both assembly
   and execution continue to query current policies independently.

3. **Read each Redis provider catalog with one atomic Lua snapshot.**
   Client commands drop 18 → 6 and sequential dependency waves 3 → 1 for six
   providers. Warm visibility loading on real local Redis falls 1.0258 → 0.7343 ms
   (28.4%). Both generation observations are inside EVAL and still compared by the
   caller. The fallback, exact-byte memo, retention and live-policy filter remain.
   Production Lua runs in pure-unit race tests via a dev-only Lua VM. Details,
   noncanonical-generation fallback and standalone/Cluster scope are in README.md.

Commands, methodology, before/after numbers and isolation setup are in README.md.
No end-to-end provider calls were possible without OAuth apps; assembly uses real
MCP protocol requests with stub DB methods and a real in-memory discovery store.
The policy benchmark uses real isolated PostgreSQL 17 with temporary tables.

## Deferred opportunities (not measured speedups)

| Area | Evidence / hypothesis | Possible impact | Needed before changing |
| --- | --- | --- | --- |
| Frontend | AppShell renders lazy Chat even on non-chat pages | Deferring until first chat visit could avoid the 285.39 KB chat chunk (99.92 KB gzip) on integration-only sessions | Confirm intended background chat/history behavior and test streaming continuity when navigating; retain mount after first activation |
| Admin writes / indexes | Policy batches issue one upsert and one preference delete per tool; preference PK starts with user_id but reconciliation deletes by tool_name | A 300-tool batch performs 600 sequential mutations; tool-name deletes may scan all preferences | EXPLAIN ANALYZE with realistic user/preference counts, bulk reconciliation correctness tests, and a new index migration if justified |
| HTTP static compression | Immutable asset caching exists, but the app does not compress responses itself | Main JS is 633.77 KB raw versus 204.17 KB gzip in Vite output | Verify whether deployment ingress already compresses before adding precompression or middleware; avoid compressing streaming traffic blindly |
| Pool / startup | pg uses the default pool; startup waits for Redis/events, not upstream discovery | Unknown; no measured bottleneck | Load profile, connection counts across replicas, and cold-start measurements before tuning/deferment |

## Already inexpensive / already optimized

- AES-256-GCM decryption of a 1 KB synthetic credential: 0.003–0.004 ms median.
  The 32-byte key is already loaded once; no per-call key derivation. No change.
- Warm visible-tool loading plus policy filtering after memoization: 0.046 ms
  for 300 tools. Filtering uses sets and is linear; no tools × providers loop.
- Independent assembly DB reads already run with Promise.all; connected-provider
  discovery already runs concurrently. Token lookups use primary keys; user-local
  preference and connection queries project narrow fields and use leading PKs.
- Mermaid is already a dynamic import. The large 682.31 KB Mermaid core chunk
  (168.96 KB gzip) is not an eager app-entry dependency. Most routes are lazy;
  markdown and code rendering already have React.memo/useMemo boundaries.
- Fingerprint normalization is already memoized by exact catalog bytes; the win
  was moving the memo lookup before parsing/validation, not weakening hashing.

## Verification / caveats

Before each commit and at completion: `npm run lint && npm run typecheck && npm test && npm run build`.
All 35 suites / 405 tests pass; configured coverage thresholds pass (aggregate
91.83% statements, 87.85% branches). Server and client builds pass. Vite's existing
>500 KB chunk warning remains; frontend bundle contents were not changed.
`npm ci` reported four existing moderate dependency vulnerabilities; dependency
upgrades were outside this performance audit.

SDK detail encountered by the benchmark: `LATEST_PROTOCOL_VERSION` exports the
legacy `2025-11-25` revision, which the application's strict handler rejects.
The benchmark uses the supported modern `2026-07-28` per-request envelope.
The SDK also logs its existing JSON-response-mode notification warning.

# MCP hot-path benchmark

Run `npx tsx bench/mcp-assembly.ts` from this worktree. No provider credentials,
Postgres or Redis are required. The benchmark uses the real MCP handler,
visibility filter and discovery cache, with an in-memory string store and stub
policy/preference queries. It seeds 300 tools across all six providers, each
with nested input/output schemas. A real `tools/list` response is checked for
300 registrations before measuring. No upstream execution occurs.

Each result reports the median of seven samples of 200 requests after 50 warmup
requests. `server/discover` measures per-request assembly plus SDK transport
and a small response, not network/authentication/database latency. `tools/list`
also includes serializing and parsing the tool catalog. The script uses the
SDK's modern `2026-07-28` envelope; its exported `LATEST_PROTOCOL_VERSION`
currently names the rejected legacy revision `2025-11-25`.

## Exact-byte discovery memoization

Node 25.6.1, local macOS, same synthetic fixture:

| Median milliseconds / request | Before | After |
| --- | ---: | ---: |
| Visible tools, warm memory cache | 1.0500 | 0.0462 |
| MCP assembly + server/discover transport | 1.9554 | 0.8982 |
| MCP assembly + tools/list transport/serialization | 3.5673 | 2.7080 |
| AES-256-GCM decrypt, 1 KB payload (unchanged) | 0.0040 | 0.0031 |

These are CPU/local-stub timings, not production latency or throughput claims.
The existing 256-entry bound is preserved. Every read still consults the store,
checks generation twice, verifies exact bytes and enforces retention. Policies
are still fetched and filtered on every request.

## Narrow policy decision reads

For a real, isolated Postgres/Redis fixture, copy `.env.example` to `.env`,
generate `ENCRYPTION_KEY` and set its database port to `25432` and Redis port to
`26379`. Then:

```sh
docker compose -p bifrost-audit-perf -f docker-compose.yml -f bench/compose.yaml up -d --wait postgres redis
npx tsx --env-file=.env bench/tool-policies.ts
```

The database benchmark uses a session-local temporary table (no migrations or
writes to persistent tables), 300 policies, twelve described input fields per
tool, and nested output schemas. It asserts that the enforcement decisions
exactly equal the corresponding fields from full review rows. Timings include
Postgres, local Docker TCP, JSON decoding and Drizzle mapping. Each median uses
seven samples of 100 queries after 30 warmups. Payload size is application JSON,
not raw PostgreSQL protocol bytes.

| Median milliseconds / query | Full reviews | Narrow decisions |
| --- | ---: | ---: |
| Before implementation (prototype projection) | 3.6382 | 0.3764 |
| After implementation (actual store methods) | 3.4478 | 0.3546 |
| Returned application JSON bytes | 629,881 | 44,941 |

The implemented query is 89.7% faster in the paired after run and returns
92.9% fewer application JSON bytes. Assembly and execution each use this live
narrow read. Full contract snapshots remain available for review UI callers.

Final MCP rerun (same stub fixture, after both commits' code changes): visible
loading 0.0404 ms; assembly + server/discover 0.7709 ms; tools/list 2.3920 ms;
1 KB decrypt 0.00368 ms. Shared-host/JIT variation is why the cache commit reports
the more conservative initial after measurements, rather than claiming the
later variation as another optimization. The stub MCP run does not include the
independently measured PostgreSQL win.

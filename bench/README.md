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
docker compose -f bench/compose.yaml up -d --wait postgres redis
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


## Atomic Redis discovery snapshots

```sh
docker compose -f bench/compose.yaml up -d --wait redis
REDIS_URL=redis://127.0.0.1:26379 npx tsx bench/redis-discovery.ts
```

`bench/compose.yaml` is now standalone, uses the isolated `bifrost-audit-perf`
project and publishes only loopback ports 25432/26379. The benchmark seeds a
unique user, cleans up its keys, and never uses provider credentials. It compares
actual `loadVisibleUserTools` calls (300 tools / six providers, stub PostgreSQL
methods, live policy filtering) using the old three-read algorithm from 94c3a08
versus the new Redis adapter. Exact-byte decode memoization is warm in both.
Real Redis Lua execution includes absent generation zero and nonzero generations.

Nine samples of 200 requests per variant follow 50 warmups. Variant ordering
alternates each sample. EVAL calls are counted and asserted for a warm request;
round-trip waves are the maximum dependent Redis commands per provider, since
all six providers start concurrently. These are client command/dependency counts,
not TCP packet counts: Lua still executes three GETs internally per provider.

Node 25.6.1, Redis 8 in local Docker:

| Per warm visibility request | Before | After |
| --- | ---: | ---: |
| Client-issued Redis commands | 18 | 6 |
| Sequential round-trip dependency waves | 3 | 1 |
| Median wall time (ms) | 1.0258 | 0.7343 |

This is a 28.4% wall-time reduction, not a claim about full MCP/provider latency.
The unchanged CPU work and catalog transfer remain included.

### Why the snapshot is safe

One Lua EVAL reads generation, the entry for that generation, then generation
again, returning all three observations. Redis serializes the entire script
against other clients: a concurrent invalidate, publish or delete is ordered
before or after the snapshot, never between those reads. The TypeScript caller
still compares both parsed generations and retries a torn snapshot. The old
algorithm could also linearize just before an invalidation that completed after
its final generation read; this change does not promise post-snapshot revocation.
The in-memory fallback performs the same three observations without an await.

The script derives a generation-specific entry key; it intentionally targets the
existing standalone Redis client/key layout, **not Redis Cluster**. Cluster would
need a fixed, same-slot key layout (for example a versioned hash) and migration.
Normal generations written by INCR are canonical decimal strings. Noncanonical
or corrupt generation strings retain the prior JS parseInt normalization through
a guarded serial fallback rather than looking up a differently named entry.
Those exceptional reads are not atomic but keep the final generation comparison.

The upstream refresh itself and its write-publication sequence are not made
atomic. Both write-side generation checks and stale-generation cleanup remain
unchanged; holding Redis execution across an upstream network call is neither
possible nor appropriate. Six providers remain six independent snapshots, just
as they were independent before. Per-request policy filtering, raw-byte matching,
retention enforcement and the 256-entry decoded bound are untouched.

Pure unit tests execute the exact production Lua with a dev-only Fengari VM and
fake redis.call operations. Concurrent writes attempted after the first GET queue
until EVAL completes. Cases cover generation changes (including a deliberately
faulty non-atomic store to test the retained retry), refresh publication, deletion,
missing keys, malformed replies, noncanonical generations, fallback TTL and the
write-publication race. The Lua VM is not imported into server or browser builds.

## MCP load benchmark

```sh
npm run integration -- bench                          # throwaway Postgres + Redis on loopback
npm run integration -- bench --upstream-latency-ms 20 --save bench/results/<name>.json
```

`bench/mcp-load.ts` runs on `test/integration/harness.ts`: the real Hono app and per-request MCP
assembly, real PostgreSQL and Redis, bearer tokens from the grant store, and an in-process SDK MCP
server standing in for GitHub over loopback HTTP. Requests are sequential, so each sample is a
latency rather than queueing. Warm samples follow 30 warmup requests; **cold** samples invalidate
the caller's cached listing first (outside the timed window), forcing a blocking upstream
discovery. Calls rotate across 25 users to stay under GitHub's 80 calls per user per minute.
`--upstream-latency-ms` delays every HTTP request the fake upstream answers. `bench:load` sets
`LOG_LEVEL=warn` so per-request info logs do not flood the terminal. Options: `--tools` (default
40), `--warm` (300), `--cold` (100), `--save <path>`.

The Bifrost side is called in process (`app.request`), so client↔Bifrost TCP is not included.

### Baseline (before any performance change)

Node 24.22.1, macOS arm64, Postgres 17 and Redis 8 in local Docker, 40 tools, idle machine.
Raw results: `bench/results/mcp-load-baseline.json` and `mcp-load-baseline-20ms.json`.

| ms | Upstream +0 ms p50 | p95 | Upstream +20 ms p50 | p95 |
| --- | ---: | ---: | ---: | ---: |
| `tools/list` warm | 2.14 | 6.19 | 2.16 | 6.58 |
| `tools/list` cold | 7.92 | 10.18 | 84.89 | 98.85 |
| `tools/call` warm | 4.22 | 6.79 | 81.56 | 91.94 |
| `tools/call` cold | 10.21 | 15.28 | 171.22 | 181.67 |

With +20 ms per upstream HTTP request, a warm `tools/call` costs four upstream round trips:
every call opens a new upstream MCP client, which sends `initialize`, `notifications/initialized`,
a GET for the server-sent event stream, and only then the call. A cold call pays the same four
again for discovery's `tools/list`. The +0 ms column is
Bifrost's own overhead: auth, policy/preference reads, Redis catalog and limits, assembly and
serialization.

### After the hot-path changes

Same machine and fixture. C1–C3 pool upstream clients, read per-user visibility in one query and
stop stamping grants on every call. C4 resolves only the named tool for `tools/call`. Each +0 ms
cell is the median of three runs, and identical code moved 2–3 ms at p50 between runs there, so
read that column as noise unless a change is larger. Raw results are in
`bench/results/mcp-load-after-{pooling,c4}{,-20ms}.json`.

| ms, p50 / p95 | +0 before | +0 C1–C3 | +0 C1–C4 | +20 before | +20 C1–C3 | +20 C1–C4 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `tools/list` warm | 2.14 / 6.19 | 2.36 / 6.62 | 2.36 / 6.61 | 2.16 / 6.58 | 2.37 / 7.46 | 2.49 / 7.39 |
| `tools/list` cold | 7.92 / 10.18 | 9.95 / 18.06 | 9.27 / 15.07 | 84.89 / 98.85 | 39.64 / 46.99 | 39.69 / 45.97 |
| `tools/call` warm | 4.22 / 6.79 | 2.97 / 5.91 | 3.16 / 7.29 | 81.56 / 91.94 | 37.69 / 47.74 | 35.45 / 44.68 |
| `tools/call` cold | 10.21 / 15.28 | 12.73 / 23.67 | 4.88 / 7.37 | 171.22 / 181.67 | 70.11 / 79.55 | 63.39 / 76.36 |

The +20 ms columns show the pool. A warm call used to make four upstream round trips and now
makes one; a cold one went from eight to two. C4 is what moves cold `tools/call` at +0 ms, from
about 12 ms to 5: a call no longer registers and serializes all 40 tools, and discovery reads only
the named tool's provider. Measured alone against the same local Postgres, the per-request reads
dropped from 0.33 to 0.26 ms p50, and a bearer check inside the stamp window no longer writes.
Interleaved in one process, a cold listing through a pooled client took 8.8 to 11.8 ms p50 against
11.3 to 11.7 ms through a fresh one. What remains of a cold listing is discovery itself, meaning
the Redis lock and write plus normalizing and fingerprinting 40 tools, which none of this touched.

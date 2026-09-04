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

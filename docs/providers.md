# Providers

Six real providers proxy their official Streamable HTTP MCP servers. To add one, follow
[adding-a-provider.md](adding-a-provider.md).

| Provider | MCP endpoint |
| --- | --- |
| `github_` | `https://api.githubcopilot.com/mcp/` |
| `linear_` | `https://mcp.linear.app/mcp` |
| `sentry_` | `https://mcp.sentry.dev/mcp` |
| `slack_` | `https://mcp.slack.com/mcp` |
| `notion_` | `https://mcp.notion.com/mcp` |
| `granola_` | `https://mcp.granola.ai/mcp` |

Tool names, descriptions, schemas and annotations are discovered per user. Bifrost prefixes names,
fingerprints normalized definitions, and treats only `readOnlyHint === true` as read-only. Missing
or false mutability metadata is write-capable, by design.

## Discovery cache

Discovery is cached in Redis by `(userId, providerId)` for one hour using stale-while-revalidate.
Entries may remain stale for at most 24 hours while one distributed refresh runs; failures retain
stale data and back off from 5 seconds to 5 minutes. Connect, reconnect, disconnect and upstream
execution errors invalidate by advancing a generation, so an older refresh cannot repopulate the
entry. Browser responses carry relative `freshForMs` and `nextCheckInMs` hints; TanStack uses the
remaining server freshness, capped at one hour, plus 0–5 seconds of deterministic refetch jitter.

`src/server/providers/upstream-pool.ts` keeps one connected upstream client per user and
provider. Discovery and calls reuse it, so only the first request pays the `initialize` handshake.
When a refresh or reconnect changes the access token, the pool opens a new client before it sends
anything. It closes a client on disconnect, after `UPSTREAM_CLIENT_IDLE_SECONDS` without use, on
shutdown, and when the process holds more than `UPSTREAM_CLIENT_MAX`, starting with the least
recently used idle one. A failure retires the client. The pool sends an operation again only
after a 404 on a client that held a session, which is how a Streamable HTTP server rejects a
session it dropped without processing the request. It resends once, on a fresh connection.
Concurrent calls share one client. The SDK matches responses by JSON-RPC id and Streamable HTTP
sends each request as its own POST, so nothing queues.

Execution reuses the exact cached upstream definition and therefore avoids a separate `tools/list`
round trip. A thrown call or MCP error result invalidates the cache and is returned without an
automatic retry, because retrying a write could duplicate it. The next request refreshes discovery
and the normal fingerprint policy fails closed if the contract changed. Policy approval itself
always reads upstream fresh.

## The prefix invariant

**Each provider owns exactly one prefix**, and that prefix has to be identical in four places
in `src/server/providers/registry.ts`. `assertPrefixInvariant` runs at startup and refuses to boot on a
one-character drift, because prefix drift silently breaks credential lookup rather than erroring.

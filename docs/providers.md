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

Execution reuses the exact cached upstream definition and therefore avoids a separate `tools/list`
round trip. A thrown call or MCP error result invalidates the cache and is returned without an
automatic retry, because retrying a write could duplicate it. The next request refreshes discovery
and the normal fingerprint policy fails closed if the contract changed. Policy approval itself
always reads upstream fresh.

## The prefix invariant

**Each provider owns exactly one prefix**, and that prefix has to be identical in four places
in `src/server/providers/registry.ts`. `assertPrefixInvariant` runs at startup and refuses to boot on a
one-character drift, because prefix drift silently breaks credential lookup rather than erroring.

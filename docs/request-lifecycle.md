# Request lifecycle

How the three kinds of traffic reach Bifrost, and the per-request MCP assembly that makes
tool filtering an enforcement mechanism.

## The shape of a request

Bifrost is a single Hono application served on Node by `@hono/node-server` (`src/server/main.ts`).
It serves three different kinds of traffic on one port:

| Traffic | Authenticated by | Resolves against |
| --- | --- | --- |
| Browser UI and its `/api/*` | `bifrost_session` cookie | `sessions` table |
| Agent calls to `/mcp` | OAuth 2.1 bearer token | `oauth_access_tokens` table |
| OAuth endpoints, discovery, `/healthz` | nothing | — |

`authenticateBrowser` and `authenticateAgent` (`src/server/http/auth.ts`) are deliberately separate
functions over separate tables. They used to share one, which meant a leaked session cookie worked as an API token.
Do not merge them back.

Both re-check the sign-in policy (`ALLOWED_EMAIL_DOMAINS`, `ALLOWED_EMAILS`) against the user's
current email on every request; the session and token lookups return it in the same query.
Removing someone from the lists ends their browser sessions and agent access at their next request
without deleting anything. Administrator rights (`ADMIN_EMAILS`) are also read on every request.

The React SPA (`src/app`) is built by Vite and served through Hono by that same Node process,
so there is one deployment, not two. Its built-in chat uses a Vercel AI SDK
`ToolLoopAgent`, Claude through the Anthropic provider, and the browser user's visible Bifrost
tools. Chat history stays client-side in IndexedDB.

## The one thing to understand first

**The MCP server object is rebuilt from scratch on every single HTTP request.** The SDK's
`createMcpHandler` factory runs per request (its own docs: *"one serving unit: one HTTP
request"*), and `createHumanMcpHandler` in `src/server/mcp.ts` uses that to load the caller's
connections and preferences and register only their tools.

`src/server/http/mcp.ts` calls the SDK's web-standard handler directly with Hono's `Request`. Do not
reintroduce a Node request adapter: Hono, the MCP SDK and the provider clients all speak the
Fetch API already.

That makes filtering *the* enforcement mechanism, not a display concern. A tool dropped by
`visibleTools` is absent from `tools/list` **and** uncallable by name, because it was never
registered on the object handling this request. There is no second check to keep in sync.
See [tool-visibility.md](tool-visibility.md) for the axes that can hide a tool.

A `tools/call` does not assemble the whole set. `loadVisibleUserTool` resolves only the tool named
in the `Mcp-Name` header, which the SDK checks against the body. It reads the same per-user state
and live policies, asks discovery for that one provider's cached listing, and sends that single
definition through the same `isToolEnabled` and `visibleTools` as the full listing.
`test/tool-call-visibility.test.ts` compares both paths across every visibility axis. The SDK only
dispatches calls to registered tools, so the server for a call holds that one tool or nothing. An
invisible tool gets the same "Tool … not found" error as before. `tools/list` and every other
method still register the full set.

Registration is also where one bad definition must not become everyone's outage: discovery keeps
the first of two upstream tools sharing a name, and a tool the SDK refuses to register is logged
and left out rather than failing the request for every other provider.

Each registered tool is a proxy to the provider's official MCP server. Execution uses the exact
upstream definition from the shared one-hour Redis catalog while reloading Bifrost's own policy and
preference state from PostgreSQL. An upstream error invalidates that catalog and is never retried
automatically; the next request discovers fresh, and a changed fingerprint remains blocked until
approved. This deliberately permits an undetected compatible upstream contract change for at most
the cache freshness window.

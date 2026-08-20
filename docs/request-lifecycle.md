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

The React SPA (`src/app`) is built by Vite and served through Hono by that same Node process,
so there is one deployment, not two. Its built-in chat uses a Vercel AI SDK
`ToolLoopAgent`, OpenAI's Responses API, and the browser user's visible Bifrost
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

Each registered tool is a proxy to the provider's official MCP server. Execution reloads the
upstream definition and verifies its fingerprint before forwarding the call. A contract that changes
between discovery and execution is denied even if the request-local server already registered it.

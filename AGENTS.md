# AGENTS.md

Context for agents and engineers working on Bifrost. For running it, read
[README.md](README.md); for registering provider apps, [SETUP.md](SETUP.md); for adding a
provider, [docs/adding-a-provider.md](docs/adding-a-provider.md).

## What this is

Bifrost is one internal MCP endpoint that gives an AI agent user-attributed access to GitHub,
Linear and Slack. A person signs into Bifrost with Google, connects their own provider accounts
once, and points their coding agent at `POST /mcp`. The agent then acts **as that person**,
using their permissions, without ever holding a provider token.

Two things follow from that and explain most of the design:

- **Provider credentials never leave the server.** They are encrypted with AES-256-GCM and only
  ever decrypted to make an outbound call.
- **Which tools an agent sees depends on who is asking.** There is no single global tool list.

## The shape of a request

Bifrost is a single Node HTTP server (`src/server.ts`, plain `node:http`, no framework) that
serves three different kinds of traffic on one port:

| Traffic | Authenticated by | Resolves against |
| --- | --- | --- |
| Browser UI and its `/api/*` | `bifrost_session` cookie | `sessions` table |
| Agent calls to `/mcp` | OAuth 2.1 bearer token | `oauth_access_tokens` table |
| OAuth endpoints, discovery, `/healthz` | nothing | — |

`authenticateBrowser` and `authenticateAgent` (`src/http/auth.ts`) are deliberately separate
functions over separate tables. They used to share one, which meant a leaked session cookie worked as an API token.
Do not merge them back.

The React SPA (`src/pages`, `src/components`) is built by Vite and served as static files by
that same Node server, so there is one deployment, not two.

## The one thing to understand first

**The MCP server object is rebuilt from scratch on every single HTTP request.** The SDK's
`createMcpHandler` factory runs per request (its own docs: *"one serving unit: one HTTP
request"*), and `createHumanMcpHandler` in `src/mcp.ts` uses that to load the caller's
connections and preferences and register only their tools.

That makes filtering *the* enforcement mechanism, not a display concern. A tool dropped by
`visibleTools` is absent from `tools/list` **and** uncallable by name, because it was never
registered on the object handling this request. There is no second check to keep in sync.

The one deliberate exception is the write-ceiling assert inside `registerTool`
(`src/mcp.ts:101`). It is redundant with the filter on purpose: hiding a tool should never be
the only thing standing between an agent and a write.

## Tool visibility: the axes that can hide a tool

`visibleTools` (`src/tools/filter.ts`) fails closed on each axis independently:

1. The provider mounted at startup.
2. The user has a `provider_credentials` row for it.
3. The user has not hidden the provider in Integrations.
4. The tool is not in `disabledTools`.

Axis 4 is computed by `src/tools/preferences.ts` from **two authorities that must both agree**,
and keeping them apart is the whole point:

- **The deployment ceiling**, `WRITE_TOOL_ALLOWLIST`. Applies to write tools only. **Empty means
  no ceiling**, not "deny everything" — that reversal is intentional and the server logs a
  warning at startup when it is unset. Naming tools forbids every other write outright, and the
  UI marks those as blocked instead of offering a switch that cannot work.
- **The user's own preference**, per tool, set on `/integrations/:providerId`.

The default when no preference row exists depends on what the tool does:

```ts
preferences.get(tool.name) ?? tool.mutability === 'read'
```

Reads start on, writes start off. Encoding the default here rather than seeding rows means a
brand-new user and a user who never opened the screen behave identically.

## Providers

Three real providers, 17 tools, 4 of them writes:

| Provider | Tools | Writes |
| --- | --- | --- |
| `github_` | 6 | `github_create_issue_comment` |
| `linear_` | 6 | `linear_create_issue`, `linear_add_comment` |
| `slack_` | 5 | `slack_post_message` |

Every tool is an explicit hand-written wrapper with a Zod input schema, never a dynamic
pass-through to the upstream API.

**Each provider owns exactly one prefix**, and that prefix has to be identical in four places
in `src/providers/registry.ts`. `assertPrefixInvariant` runs at startup and refuses to boot on a
one-character drift, because prefix drift silently breaks credential lookup rather than erroring.

Notion appears in the frontend catalog (`src/api/catalog.ts`) but has **no server-side provider**.
`/api/app-connections.json` only ever returns `SUPPORTED_APPS`, so Notion renders as a
decorative, permanently unavailable card. Do not treat it as a fourth provider.

## OAuth: Bifrost is on both sides

This trips people up. Bifrost is simultaneously:

- **An OAuth client**, to Google (sign-in) and to GitHub/Linear/Slack (provider connections).
  That is `src/oauth.ts`.
- **An OAuth 2.1 authorization server plus resource server**, to MCP clients like Claude Code.
  That is all of `src/oauth-server/` and it implements the MCP `2026-07-28` authorization spec.

The agent-facing half is why agent access does not expire the way a static key would: the client
holds a short access token (1h) and a rotating refresh token (90d, slid forward on each use), and
replaces its own credential without anyone being asked to log in again.

Worth knowing before touching `src/oauth-server/`:

- **Dynamic Client Registration is deprecated** in 2026-07-28, replaced by Client ID Metadata
  Documents. Both paths are implemented; `OAUTH_ENABLE_CLIENT_ID_METADATA_DOCUMENTS` decides
  which one clients take, because advertising support is what makes them choose.
- **Refresh tokens rotate with replay detection.** A spent token presented again destroys the
  entire grant rather than just declining, because a replay means the value leaked.
- **Tokens are opaque, stored as SHA-256 hashes.** Not JWTs: this gives instant revocation and no
  key management, and the bearer regex in `authenticateAgent()` would not match a JWT's dots anyway.
- **`redirect-uri.ts` implements the RFC 8252 loopback port exception.** It looks like a
  loophole and is not: Claude Code publishes `http://localhost/callback` with no port and binds an
  ephemeral one at runtime, so without this its CIMD flow cannot complete.
- **`ssrf.ts` guards CIMD fetches**, which are server-side fetches of a URL the caller supplies.
  HTTPS only, IP range checks, no redirects, 5s timeout, 64KB cap.
- **Never log token or auth-code values.** The logger takes ids, never material.

## Layout

```
src/
  server.ts            bootstrap and the top-level dispatcher; ~80 lines
  http/                context types, response/body helpers, static files, the two authenticators
  routes/              public, OAuth-server, /mcp and signed-in API route families
  mcp.ts               per-request MCP server assembly, tool execution, rate/concurrency limits
  errors.ts            AgentFacingError: the only error messages that reach the calling agent
  db.ts                every SQL query; the only place SQL lives
  oauth.ts             Bifrost as an OAuth client (Google + providers)
  config.ts            Zod-validated env; refuses to start on bad config
  coordination.ts      Redis locks, rate limits, concurrency leases (degrades to in-process)
  oauth-server/        Bifrost as an OAuth 2.1 authorization server
  providers/           one file per provider + the registry and its invariant
  tools/               filter.ts (who sees what) and preferences.ts (why)
  security/            secrets.ts (AES-256-GCM), access.ts (sign-in allowlist)
  status/upstream.ts   vendors' public uptime feeds
  clients/describe.ts  user agent -> recognizable client name, monogram and logo
  api/                 bifrost.ts facade over live.ts / mock.ts, chosen once by VITE_USE_MOCK_API
  pages/, components/, lib/   the React SPA
migrations/            node-pg-migrate, .cjs, applied on container boot
test/                  vitest, pure units only; no database in tests
```

**The frontend/backend boundary is enforced by TypeScript config, not convention.**
`tsconfig.json` excludes `src/api`, `src/components`, `src/pages`, `src/lib`; `tsconfig.app.json`
includes only those. A shared type is therefore written out twice on purpose (`ProviderId`,
`ClientLogoId`). Do not "fix" that with a cross-boundary import.

## Data model

`users`, `sessions`, `provider_credentials` (encrypted), `user_provider_preferences`,
`user_tool_preferences`, and the OAuth server's `oauth_clients`, `oauth_grants`,
`oauth_access_tokens`, `oauth_refresh_tokens`.

Preference tables store **only deviations from the default**, keyed `(user_id, thing)`. Absence
of a row is meaningful, so never backfill them.

## Conventions

Beyond what eslint enforces (`strictTypeChecked` + `stylisticTypeChecked`, plus
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`):

- **Comments explain why, never what.** The codebase is dense with reasoning comments and has
  almost no narration. Match that: if a line only restates the code, delete it.
- **Fail closed and raise.** Do not swallow exceptions or auto-recover with a default. User-facing
  error messages carry no technical detail.
- **Do not make a parameter optional if every caller passes it.** `disabledTools` is required in
  `UserToolVisibility` specifically so a new caller has to decide.
- **The UI must not claim anything the server does not do.** Several rounds of work here were
  spent removing screens that promised capabilities that did not exist. If you cannot wire it,
  do not draw it.
- American spelling in user-facing text.
- Brand logos come from svgl through the shadcn CLI, never hand-converted:
  `npx shadcn@latest add @svgl/<slug>`. The `@svgl` registry is already in `components.json`.

## Verification

```bash
npm run lint && npm run typecheck && npm test
```

Tests are pure units on the parts where being wrong is expensive: the prefix invariant, the
visibility filter, tool-preference defaults, PKCE, redirect-URI matching, SSRF ranges, metadata
documents, encryption, sign-in access rules. There is no database in the test suite; anything
needing one is verified by running it.

## Gotchas that cost real time

- **Page names mirror their routes and screen labels.** `/integrations` maps to
  `integrations-page.tsx`, `/agents` to `agents-sessions-page.tsx`, `/account-security` to
  `account-security-page.tsx`, and `/service-status` to `service-status-page.tsx`.
- **The Docker image contains its own copy of `dist`.** Rebuilding on the host does nothing to a
  running container. Deploying a change means `docker compose up -d --build app`. Forgetting this
  looks exactly like a change that did not work.
- **Port 3000 is contested.** `npm run dev` stops the `app` container because the watched server
  wants the same port. Before killing whatever holds 3000, identify the process first — that port
  is also held by the Docker proxy, and killing it blindly takes the whole daemon down.
- **Dev work happens on `:5173`, not `:3000`.** Vite proxies `/api`, `/auth`, `/oauth` and `/mcp`
  to the API.
- **`npm run migrate` outside Docker needs `DATABASE_URL` on `localhost:5432`**, not the
  compose-internal `postgres` host.
- **Never rename a constraint in an already-applied migration.** Rolling back to fix it destroys
  real rows. Write a new migration, or `ALTER ... RENAME CONSTRAINT` in place.
- `ENCRYPTION_KEY` has no dev default by design and the server refuses to start without it.

## Known gaps

Honest state, so nobody rediscovers these as bugs:

- `POST /mcp/internal` returns `501`. Service-account identity and per-service prefix allowlists
  were designed and deliberately not built; `INTERNAL_ONLY_PREFIXES` and the `endpoint` axis in
  `UserToolVisibility` are the scaffolding left for it.
- OAuth issues a single `mcp` scope. Per-provider scopes are the natural next axis, which is why
  grants store a `text[]` rather than one string.
- Bifrost logs `userId` in the clear on every MCP call. Hashing it in logs would be an
  improvement if an audit trail is ever built.

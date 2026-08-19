# AGENTS.md

Context for agents and engineers working on Bifrost. For running it, read
[README.md](README.md); for registering provider apps, [SETUP.md](SETUP.md); for adding a
provider, [docs/adding-a-provider.md](docs/adding-a-provider.md).

## What this is

Bifrost is one internal MCP endpoint that gives an AI agent user-attributed access to GitHub,
Linear, Sentry and Slack. A person signs into Bifrost with Google, connects their own provider accounts
once, and points their coding agent at `POST /mcp`. The agent then acts **as that person**,
using their permissions, without ever holding a provider token.

Two things follow from that and explain most of the design:

- **Provider credentials never leave the server.** They are encrypted with AES-256-GCM and only
  ever decrypted to make an outbound call.
- **Which tools an agent sees depends on who is asking.** There is no single global tool list.

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
so there is one deployment, not two.

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

Each registered tool is a proxy to the provider's official MCP server. Execution reloads the
upstream definition and verifies its fingerprint before forwarding the call. A contract that changes
between discovery and execution is denied even if the request-local server already registered it.

## Tool visibility: the axes that can hide a tool

`visibleTools` (`src/server/tools/filter.ts`) fails closed on each axis independently:

1. The provider mounted at startup.
2. The user has a `provider_credentials` row for it.
3. The user has not hidden the provider in Integrations.
4. The exact discovered fingerprint has an approved deployment policy.
5. The policy default or the user's own preference enables the tool.

Deployment policy has three states: `blocked`, `allowed_default_off`, and `allowed_default_on`.
No row, a missing tool, or a fingerprint mismatch is always `blocked`. Administrators listed in
`ADMIN_EMAILS` review these policies under `/admin/tools/:providerId`; batch changes are committed
atomically and rejected when any submitted fingerprint is stale.

User preferences store only deviations from the approved deployment default. This keeps deployment
approval and user choice as separate authorities and makes absence meaningful.

## Providers

Four real providers proxy their official Streamable HTTP MCP servers:

| Provider | MCP endpoint |
| --- | --- |
| `github_` | `https://api.githubcopilot.com/mcp/` |
| `linear_` | `https://mcp.linear.app/mcp` |
| `sentry_` | `https://mcp.sentry.dev/mcp` |
| `slack_` | `https://mcp.slack.com/mcp` |

Tool names, descriptions, schemas and annotations are discovered per user. Bifrost prefixes names,
fingerprints normalized definitions, and treats only `readOnlyHint === true` as read-only. Missing
or false mutability metadata is write-capable, by design.

Discovery is cached by `(userId, providerId)` for one hour using stale-while-revalidate. Expired
entries return immediately while one deduplicated refresh runs; failures retain stale data and back
off from 5 seconds to 5 minutes. Connect, reconnect and disconnect invalidate the entry. Browser
responses carry relative `freshForMs` and `nextCheckInMs` hints; TanStack uses the remaining server
freshness, capped at one hour, plus 0–5 seconds of deterministic refetch jitter. Never use this cache
for the execution-time fingerprint check or policy approval: both must read upstream fresh.

**Each provider owns exactly one prefix**, and that prefix has to be identical in four places
in `src/server/providers/registry.ts`. `assertPrefixInvariant` runs at startup and refuses to boot on a
one-character drift, because prefix drift silently breaks credential lookup rather than erroring.

Notion appears in the frontend catalog (`src/app/api/catalog.ts`) but has **no server-side provider**.
`/api/app-connections.json` only ever returns `SUPPORTED_APPS`, so Notion renders as a
decorative, permanently unavailable card. Do not treat it as a fifth provider.

## OAuth: Bifrost is on both sides

This trips people up. Bifrost is simultaneously:

- **An OAuth client**, to Google (sign-in) and to GitHub/Linear/Sentry/Slack (provider connections).
  That is `src/server/oauth.ts`.
- **An OAuth 2.1 authorization server plus resource server**, to MCP clients like Claude Code.
  That is all of `src/server/oauth-server/` and it implements the MCP `2026-07-28` authorization spec.

The agent-facing half is why agent access does not expire the way a static key would: the client
holds a short access token (1h) and a rotating refresh token (90d, slid forward on each use), and
replaces its own credential without anyone being asked to log in again.

The client side uses `openid-client` for authorization URLs, PKCE, provider code exchanges and
refresh grants. Linear and Sentry dynamically register public clients against their official MCP
authorization servers; their generated client IDs are stored inside the encrypted provider credential.
Sentry exposes only OAuth Authorization Server metadata, so its discovery must use the `oauth2`
algorithm. GitHub and Slack still use configured applications. Slack's user grant is normalized in
`providers/slack-oauth.ts` because Slack nests
it under `authed_user` instead of returning the standard top-level token fields. Google token
verification deliberately remains on `jose`: Google documents two valid `iss` forms, while
`openid-client` correctly enforces one exact configured issuer.

Worth knowing before touching `src/server/oauth-server/`:

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
  app/                 React SPA; route folders, shared chrome/UI, client API and frontend helpers
    main.tsx           browser bootstrap and app-wide providers
    <route>/<route>.tsx   route entry imported directly by React Router
    components/        app-wide chrome and design-system UI only
    api/               facade, TanStack Query options and the Hono RPC browser client
    lib/               app-wide formatting and presentation helpers
  server/              everything that runs only on Node
    main.ts            bootstrap, dependency assembly and @hono/node-server lifecycle
    http/              Hono app plus public/browser/MCP routers, auth, body limits and static files
    mcp.ts             per-request MCP server assembly, tool execution, rate/concurrency limits
    database/          Drizzle schema, connection and migration runner
    oauth.ts           Bifrost as an OAuth client (Google + providers)
    oauth-server/      OAuth 2.1 authorization server, including its HTTP entry
    providers/         one file per provider + the registry and its invariant
    tools/             discovery, normalized fingerprints, policy resolution and filtering
    security/          encrypted secrets and sign-in/admin allowlists
  features/            cross-runtime product contracts and code
    bifrost-api/       reusable Hono RPC client inferred from the server routes
migrations/            generated Drizzle SQL, applied on container boot
test/                  vitest, pure units only; no database in tests
```

**The frontend/backend boundary is enforced by configuration, not convention.** `tsconfig.json`
excludes `src/app`; `tsconfig.app.json` includes `src/app` plus explicitly shared `src/features`;
ESLint forbids runtime imports across `app` and `server`, and forbids runtime dependencies from
`features` into either side. The one deliberate exception is the type-only `AppType` import in
`features/bifrost-api/client.ts`: Hono RPC infers its contract from the implemented routes, and the
import is erased before bundling. Do not widen this exception or import an app type into server code.
Other shared-looking types remain written twice on purpose (`ProviderId`, `ClientLogoId`).

The three top-level source folders are deliberate: `app` is browser-only, `server` is Node-only,
and `features` is the narrow shared boundary. Do not add loose source files or another technical
bucket directly under `src`.

## Frontend architecture

This is the `job-index-v2` route-colocation model adapted to Vite. React Router still registers
URLs explicitly in `src/app/app.tsx`; the folders organize ownership and do not create routes.

- **A file lives at the closest folder that is an ancestor of every consumer.** Route-only code
  stays under that route. Code used by multiple routes moves to `app/components`, `app/lib` or
  `app/api`. Cross-runtime product contracts and code used by both sides belong in `features`.
- **The route tree mirrors the URL.** Each route owns a `<domain>.tsx` entry at its root and,
  when needed, `components/`, `hooks/` and `utils/`. Dynamic segments use bracket folders such as
  `integrations/[providerId]/` even though React Router, not Vite, interprets the parameter.
- **Do not create one-line route wrappers.** Vite gives `page.tsx` no special behavior, so
  `app.tsx` lazy-loads each route entry directly. Re-export-only modules are allowed only when
  a real package boundary needs a deliberate public API.
- **The root tree must describe product boundaries, not framework buckets.** Do not recreate
  root-level `pages/`, `components/`, `hooks/`, `lib/` or client `api/` folders.
- **Single-file items stay flat.** Create an item folder only when it has companions such as a
  test, types or a reducer. `index.ts` may only re-export; never define code in a barrel and never
  create `index.tsx`.
- **No nested item folders.** Items sit one level below their owning `components`, `hooks` or
  `utils` folder.
- **Filenames are kebab-case.** React symbols use PascalCase and hooks/functions use camelCase.
- **Aliases cross scopes; relative imports stay inside a scope.** Use `@app/*` and `@features/*`
  across boundaries. A route's screen imports its local components with `./...`; never import
  through its own barrel.
- **TanStack Query owns remote state.** Use `useQuery`/`useMutation` instead of fetching in
  effects. Shared query options live in `app/api/query-options.ts`; route-only query behavior
  stays with that route. Invalidate the narrow shared key after mutations, and use optimistic
  updates only when rollback is explicit.
- **Dates use `date-fns`.** Keep ISO timestamps across the HTTP boundary and format them in the
  browser so local time stays honest. Do not add another hand-written date arithmetic helper.
- **Browser APIs use Hono RPC.** Keep route registrations chained so `AppType` retains their input
  and response schemas. Consume them through `features/bifrost-api/client.ts`; do not recreate URL,
  body or response DTOs in the app. `parseRpcResponse` owns authenticated 401 behavior.

## HTTP architecture

- `src/server/http/app.ts` owns global Hono middleware and mounts domain routers. Keep route behavior
  in `public.ts`, `browser.ts`, `mcp.ts` or `oauth-server/http.ts`, not in `server/main.ts`.
- Use Hono's `context.json`, `context.html`, `context.redirect`, cookie helpers and static
  middleware. Do not recreate a generic `respond.ts` wrapper.
- Server-rendered HTML uses Hono JSX. Its values are escaped by the renderer; do not return to
  interpolated HTML strings or add a second React server renderer.
- Route parameters and browser JSON bodies use `@hono/zod-validator`; handlers receive validated
  values and do not parse request input themselves. Zod details never reach the caller.
- The global Hono `requestId()` middleware owns `X-Request-Id`; use `context.get('requestId')`
  instead of generating or copying request ids inside handlers.
- Preserve the **1,048,576-byte** request-body limit and return `400` for malformed JSON.
- Host validation is port-agnostic and allows only the `PUBLIC_URL` hostname, `localhost` and
  `127.0.0.1`. Security headers are global; OAuth protocol responses are always `no-store`.
- Browser routes must use only `authenticateBrowser`; `/mcp` must use only `authenticateAgent`.
  The authorization and consent routes accept an optional browser identity because sign-in is
  a normal intermediate state there.

## Data model

`users`, `sessions`, `provider_credentials` (encrypted), `user_provider_preferences`,
`user_tool_preferences`, `deployment_tool_policies`, and the OAuth server's `oauth_clients`, `oauth_grants`,
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
- **Do not make a parameter optional if every caller passes it.** `enabledTools` is required in
  `UserToolVisibility` specifically so a new caller has to decide.
- **The UI must not claim anything the server does not do.** Several rounds of work here were
  spent removing screens that promised capabilities that did not exist. If you cannot wire it,
  do not draw it.
- American spelling in user-facing text.
- Brand logos come from svgl through the shadcn CLI, never hand-converted:
  `npx shadcn@latest add @svgl/<slug> --path src/app/components/ui/svgs --yes`.
  The `@svgl` registry is already in `components.json` and the root TypeScript alias exists so
  shadcn can resolve its configured output paths.

## Verification

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

Tests are pure units on the parts where being wrong is expensive: the prefix invariant, the
visibility filter, tool fingerprints and policy defaults, PKCE, redirect-URI matching, SSRF ranges,
metadata documents, encryption, sign-in/admin access rules. There is no database in the test suite; anything
needing one is verified by running it.

## Gotchas that cost real time

- **Vite does not discover route files.** Every new route entry must be registered in
  `src/app/app.tsx` and, when the server must serve the SPA there, in `src/server/http/static.ts`.
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

- OAuth issues a single `mcp` scope. Per-provider scopes are the natural next axis, which is why
  grants store a `text[]` rather than one string.
- Bifrost logs `userId` in the clear on every MCP call. Hashing it in logs would be an
  improvement if an audit trail is ever built.

# AGENTS.md

Context for agents and engineers working on Bifrost. For running it, read
[README.md](README.md); for registering provider apps, [SETUP.md](SETUP.md).

## What this is

Bifrost is one internal MCP endpoint that gives an AI agent user-attributed access to GitHub,
Linear, Sentry, Slack, Notion and Granola. A person signs into Bifrost with Google, connects their
own provider accounts once, and points their coding agent at `POST /mcp`. The agent then acts
**as that person**, using their permissions, without ever holding a provider token.

Two things follow from that and explain most of the design:

- **Provider credentials never leave the server.** They are encrypted with AES-256-GCM and only
  ever decrypted to make an outbound call.
- **Which tools an agent sees depends on who is asking.** There is no single global tool list.
  The MCP server object is rebuilt per request with only the caller's tools registered, so
  filtering is the enforcement mechanism, not a display concern.

## Docs

The details live in `docs/`, one file per topic. Read the relevant one before touching that area:

| File | Covers |
| --- | --- |
| [docs/request-lifecycle.md](docs/request-lifecycle.md) | The three traffic kinds, separate auth paths, per-request MCP assembly |
| [docs/tool-visibility.md](docs/tool-visibility.md) | The fail-closed visibility axes, deployment policies, admin boundary |
| [docs/providers.md](docs/providers.md) | The six providers, discovery cache, the prefix invariant |
| [docs/adding-a-provider.md](docs/adding-a-provider.md) | Every touchpoint for mounting a new provider |
| [docs/oauth.md](docs/oauth.md) | Bifrost as OAuth client and as OAuth 2.1 authorization server |
| [docs/frontend.md](docs/frontend.md) | Route colocation, TanStack Query, Hono RPC rules |
| [docs/http.md](docs/http.md) | Hono routers, validation, security headers, data model |
| [docs/conventions.md](docs/conventions.md) | Code conventions and the verification commands |
| [docs/gotchas.md](docs/gotchas.md) | Gotchas that cost real time, known gaps |
| [docs/verification.md](docs/verification.md) | Verification scope, integration tests, isolated worktrees, dev identity and MCP probes |
| [docs/encryption-keys.md](docs/encryption-keys.md) | Credential record format, keyring configuration, online key rotation |

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
    mcp.ts             per-request MCP server assembly and tool registration
    database/          Drizzle schema, connection, migrations and the per-aggregate data stores
    oauth.ts           Bifrost as an OAuth client (Google + providers)
    oauth-server/      OAuth 2.1 authorization server, including its HTTP entry
    providers/         one file per provider + the registry and its invariant
    tools/             discovery, fingerprints, policy resolution, filtering, execution and rate/concurrency limits
    security/          encrypted secrets and sign-in/admin allowlists
  features/            cross-runtime product contracts and code
    bifrost-api/       reusable Hono RPC client inferred from the server routes
migrations/            generated Drizzle SQL, applied on container boot
test/                  vitest units, database-free; test/integration uses real Postgres and Redis
```

**The frontend/backend boundary is enforced by configuration, not convention.** `tsconfig.json`
excludes `src/app`; `tsconfig.app.json` includes `src/app` plus explicitly shared `src/features`;
ESLint forbids runtime imports across `app` and `server`, and forbids runtime dependencies from
`features` into either side. The one deliberate exception is the type-only `AppType` import in
`src/features/bifrost-api/client.ts`: Hono RPC infers its contract from the implemented routes, and the
import is erased before bundling. Do not widen this exception or import an app type into server code.
Other shared-looking types remain written twice on purpose (`ProviderId`, `ClientLogoId`).

The three top-level source folders are deliberate: `app` is browser-only, `server` is Node-only,
and `features` is the narrow shared boundary. Do not add loose source files or another technical
bucket directly under `src`.

## Verification

```bash
npm run verify
```

This runs lint, the Prettier check, both typechecks, database-free unit tests with coverage, and both production
builds, stopping on failure. Coverage includes selected modules, not the whole repository.
With `TEST_DATABASE_URL` and `TEST_REDIS_URL` set (CI sets both) it also runs the integration
tests; otherwise it reports them as skipped. `npm run integration -- test` starts throwaway
loopback infrastructure and runs them locally. The browser tier is not implemented. For auth/OAuth, persistence, MCP or UI changes, also exercise the affected
runtime path and report the evidence or exact blocker. Do not weaken authentication or tool
visibility to make a check pass.

For concurrent worktrees, initialize a distinct slot with `npm run worktree -- init 41`, then
use `npm run worktree -- dev`. Plain `npm run dev` still uses fixed ports and stops the Compose
`app`. The existing `BIFROST_DEV_USER_ID` seed/header path does not create browser cookies or
provider connections. See [docs/verification.md](docs/verification.md) for working local
recipes, complete MCP request headers, current boot/preview gotchas, and cleanup.

# Verification and isolated local development

## What proves what today

```bash
bun install
npm run verify
```

`verify` runs lint, `prettier --check`, both TypeScript configurations, the unit suite with its coverage gate,
the integration suite when `TEST_DATABASE_URL` and `TEST_REDIS_URL` are set, then both production
builds. It stops on failure, reports completed and skipped stages, and exits nonzero on failure.
`npm test` remains database-free. Neither proves OAuth browser navigation or rendered React routes.

Coverage is printed and written to `coverage/coverage-summary.json`. The configured include list
is selective; its percentage is **not whole-repository coverage**. For a focused unit iteration:
`npx vitest run test/auth.test.ts` (run the full gate before committing).

## Integration tests

```bash
npm run integration -- test    # starts test/integration/compose.yaml, then npm run test:integration
npm run integration -- down
```

They use their own Compose project (`bifrost-integration`), loopback ports 25433/26380 and tmpfs
storage, so they never touch the development database. Any reachable Postgres and Redis work too:
set `TEST_DATABASE_URL` (its database name must contain `test`, because global setup drops and
re-migrates the schema) and `TEST_REDIS_URL`, then `npm run test:integration`. With both set,
`npm run verify` includes the stage; CI sets both.

The suite builds the same dependency graph as `src/server/main.ts` and sends real MCP requests
with bearer tokens issued by the grant store. Provider traffic goes to an in-process SDK MCP server
over loopback HTTP: only `fetch` is rerouted for the registry's official MCP URLs, so registry,
discovery, cache and execution code run unchanged. Provider token exchanges are injected through
`OAuthService`'s existing dependency seam. It covers bearer auth → `tools/list` → `tools/call`, cold
and warm discovery, immediate admin blocks and user switches, invisible tools, concurrent token
refresh, and credential key rotation including its races with refresh.

There is no browser (end-to-end UI) tier yet. Do not claim to have run one.

## Load benchmark

`npm run integration -- bench` measures `tools/list` and `tools/call` latency against the same
fake upstream. See [bench/README.md](../bench/README.md#mcp-load-benchmark) for options and baseline.

## Local development notes

`npm run dev` starts Postgres and Redis with Compose, applies migrations, and runs the watched API
on `:3000` and Vite on `:5173`. It stops the Compose `app` container because both want port 3000.

For UI work without infrastructure, `VITE_USE_MOCK_API=true npm run dev:client` swaps in an
in-memory API. It is not fully offline; see [Boot and UI limitations](#boot-and-ui-limitations).

## Parallel worktrees

Choose a distinct slot from 1–999 for each concurrent checkout:

```bash
npm run worktree -- init 41
npm run worktree -- dev
```

Initialization creates a private, git-ignored `.worktree/env` with a random encryption key,
path-derived Compose project name, and these host ports:

| Service | Port for slot N | Slot 41 |
| --- | --- | --- |
| API | 3000 + N | 3041 |
| Vite | 5000 + N | 5041 |
| Postgres | 15000 + N | 15041 |
| Redis | 17000 + N | 17041 |

Each project has its own Postgres and Redis containers, named volumes and network. The database
name `bifrost` and Redis index 0 are safe because the servers themselves are isolated. This does
not reset or copy another checkout's data. Infrastructure publishes only on IPv4 loopback.
The existing Node API still binds all interfaces; do not mistake infrastructure isolation for
an authentication hardening change.

`dev` starts infrastructure, migrates, and launches the watched server and Vite. Its environment
wins over `.env` for ports, database, Redis and the encryption key. Optional provider settings can
still come from `.env`; register callbacks against the worktree's actual `PUBLIC_URL`.
Vite uses the same API port and refuses to silently move to a different occupied UI port.
It does not stop any `app` container. Docker/Compose must already be running.

```bash
npm run worktree -- status
npm run worktree -- run npm run migrate
npm run worktree -- run npm run verify
npm run worktree -- down
```

`down` removes only this project's containers/network and **retains volumes**. Initialization
refuses to replace an existing key or settings. Reuse the same slot after restarting. A conflicting
slot/occupied port fails at bind time; coordinate slots instead of killing another agent's process.
Always use the wrapper for isolated infrastructure: plain `npm run dev` still uses the original
Compose file, fixed ports, and `docker compose stop app`.

## Existing no-Google path (not fake provider support)

The server already seeds a user when `NODE_ENV=development` and `BIFROST_DEV_USER_ID` is a UUID.
A matching `X-Bifrost-Dev-User` header authenticates browser APIs and MCP independently. There is
no browser cookie minted by this path and no provider connection is seeded. The account email
is `<uuid>@development.invalid`; put that exact email in `ADMIN_EMAILS` for an admin fixture.

For example, after initialization and a successful build:

```bash
npm run worktree -- up
npm run worktree -- run npm run migrate
npm run worktree -- run env NODE_ENV=development \
  BIFROST_DEV_USER_ID=11111111-1111-4111-8111-111111111111 \
  ADMIN_EMAILS=11111111-1111-4111-8111-111111111111@development.invalid \
  node dist/server/main.js
```

The command uses the compiled server because rendering OAuth consent through the source runner
failed with `React is not defined` on Node 25.6.1. The compiled path completed
registration, consent, PKCE, token rotation and replay revocation with real storage.

An authenticated local list request for slot 41 is:

```bash
curl --fail-with-body http://localhost:3041/mcp \
  -H 'X-Bifrost-Dev-User: 11111111-1111-4111-8111-111111111111' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Expect an empty tool list until the user connects providers and an administrator approves their
fingerprints. The header is a local convenience, **not a test of cookie or OAuth bearer validation**.
For those, obtain real fixture sessions/tokens and omit the header on the requests under test.
Never send this header to an external site or attach it globally to browser traffic.

## Boot and UI limitations

- No OpenAI key is needed to boot; the chat reports that it is not configured.
- Omit `REDIS_URL` entirely for in-process development; an empty string does not pass `z.url()`.
  Production requires Redis. Configured-but-unavailable Redis makes `/healthz` return 503.
- Google/provider app credentials are not startup requirements. Google sign-in with no configured
  app fails with a generic 500. `/healthz` does not verify Google or database readiness.
- `VITE_USE_MOCK_API=true npm run dev:client` avoids infrastructure startup, but the mock is not
  fully offline: the always-mounted chat still requests live `/api/chat/config.json`. A 401 there
  redirects even the mocked Integrations screen to sign-in. Vendor status is deliberately live.
- Authenticated screenshots are possible with an automation browser injecting the dev header
  **only on the exact local origin**, or with a locally minted browser session. Chat still reports
  "not configured" without an OpenAI key; a fake deterministic chat model is not implemented.

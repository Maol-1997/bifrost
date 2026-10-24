# Bifrost

**One MCP endpoint that lets your coding agent use GitHub, Linear, Sentry, Slack, Notion and Granola as *you*, without ever holding your tokens.**

You sign in once with Google, connect your own GitHub, Linear, Sentry, Slack, Notion and Granola accounts, and point Claude Code (or any MCP client) at `POST /mcp`. From then on the agent reads pull requests, searches issues and meeting notes, and posts messages under your identity and permissions, while you decide, tool by tool, what it is allowed to do.

Bifrost also includes a streaming, multi-step chat powered by the Vercel AI SDK and OpenAI. It receives the signed-in user's currently visible Bifrost tools automatically, can search the live web through OpenAI Web Search, and stores chat history locally in the browser with IndexedDB.

Administrators can also ask the web chat to review an MCP provider's tool catalog and apply deployment policies in a fingerprint-checked batch. These internal administration tools exist only in the web chat and are never exposed through `POST /mcp`.

---

## Why it exists

Giving an AI agent access to your team's tools usually means one of two bad options: paste a personal access token into a config file on your laptop, or share a bot account whose actions nobody can attribute to a person. Bifrost replaces both with a small internal gateway:

- **Credentials stay on the server.** Provider tokens are encrypted with AES-256-GCM at rest and only ever decrypted to make an outbound call. The agent never sees them.
- **Every action is attributed to a person.** The agent authenticates to Bifrost with a short-lived OAuth token issued *to that user*, so a comment on GitHub or a message in Slack is posted by them, with their permissions.
- **Administrators approve the surface.** Provider tools are discovered from official MCP servers and start blocked. An administrator reviews the current contract and chooses whether each approved tool starts on or off for users.

## How it works

```
                 ┌──────────────────────── Bifrost ────────────────────────┐
                 │                                                          │
  Browser ──cookie──▶  React UI  ──▶  /api/*     Postgres (encrypted creds, │
  (Google sign-in)                                sessions, OAuth grants)  │
                 │                                                          │
  Claude Code ──bearer──▶  POST /mcp  ──▶  per-request MCP server          │──▶ GitHub
  Cursor, etc.   │        (OAuth 2.1)       built from *your* connections   │──▶ Linear
                 │                          and *your* tool preferences     │──▶ Sentry
                 │                                                          │──▶ Slack
                 │                                                          │──▶ Notion
                 │                                                          │──▶ Granola
                 └──────────────────────────────────────────────────────────┘
```

Three ideas explain most of the design:

1. **The MCP server is rebuilt on every request.** Bifrost loads the caller's connected providers and tool preferences and registers only those tools. A tool that is hidden is not merely absent from `tools/list`, it is uncallable, because it was never registered for that request.
2. **Bifrost is on both sides of OAuth.** It is an OAuth *client* to Google and to each provider (that is how it obtains your tokens), and it is an OAuth 2.1 *authorization server* to MCP clients (that is how Claude Code gets its own credential). Agent access does not silently expire: clients hold a 1-hour access token and a rotating 90-day refresh token.
3. **Two authorities decide what a tool may do.** An administrator must approve the exact fingerprint discovered from the provider, then each user can narrow that approved surface with their own switches.

## What agents get

Tools are discovered from GitHub, Linear, Sentry, Slack, Notion and Granola's official MCP servers using each user's OAuth token. Bifrost prefixes their names (`github_`, `linear_`, `sentry_`, `slack_`, `notion_`, `granola_`), preserves their schemas and annotations, and proxies approved calls without exposing provider credentials.

Discovery never grants access by itself. A new tool, or any change to a tool's contract, produces a new fingerprint and stays blocked until an administrator approves that exact version. Missing `readOnlyHint: true` metadata is treated as write-capable.

Discovered catalogs use a shared Redis stale-while-revalidate cache that is fresh for one hour and retained stale for at most 24 hours. Browser queries receive the remaining server freshness and use it as their own TanStack Query lifetime, so the two caches never add two independent hours. Tool calls reuse that cached contract; an upstream error invalidates it without retrying the call. Policy approvals always refresh upstream first.

## Quick start

Requirements: Docker with Compose v2, OAuth apps for Google and any GitHub or Slack providers you want, and no application setup for Linear, Sentry, Notion or Granola (see [SETUP.md](SETUP.md)).

```bash
cp .env.example .env
openssl rand -base64 32     # paste into ENCRYPTION_KEY in .env
docker compose up --build
```

Open <http://localhost:3000>, sign in with Google, and connect a provider from **Integrations**. Migrations run automatically when the container boots. The server refuses to start without `ENCRYPTION_KEY`.

### Connect an agent

Bifrost implements the MCP `2026-07-28` authorization spec, so a compliant client needs only the URL:

```bash
claude mcp add --transport http bifrost https://bifrost.your-company.dev/mcp
```

The client discovers the authorization server, opens the browser for consent, and stores its own token. **Agents & sessions** in the UI lists every connected client and lets you revoke any of them.

## Configuration

All settings are environment variables, validated at startup by `src/server/config.ts`.

| Variable | Required | What it does |
| --- | --- | --- |
| `ENCRYPTION_KEY` | yes | 32-byte base64 key for provider credentials. No dev default, on purpose. |
| `ENCRYPTION_KEYS`, `ENCRYPTION_ACTIVE_KEY_ID` | to rotate | JSON keyring of id to base64 key and the id new writes use. See [docs/encryption-keys.md](docs/encryption-keys.md). |
| `PUBLIC_URL` | yes in prod | The origin agents and OAuth redirects use. Default `http://localhost:3000`. |
| `DATABASE_URL` | yes | Postgres. Outside Docker, point it at `localhost:5432`, not `postgres`. |
| `DATABASE_POOL_MAX` | no | Postgres connections per process. Default 20. |
| `REDIS_URL` | production | Shares locks, atomic rate limits, concurrency leases, tool catalogs and browser invalidations across workers. Production refuses to start without it; development and tests can use local state. |
| `GOOGLE_CLIENT_ID` / `_SECRET` | yes | Sign-in. |
| `GITHUB_*`, `SLACK_*` | per provider | Provider OAuth apps. A provider without credentials still mounts; connecting it fails until they are set. Linear, Sentry, Notion and Granola use their MCP servers' dynamic client registration instead. |
| `OPENAI_API_KEY` | for chat | Enables the built-in agent chat. The rest of Bifrost still starts when it is absent. |
| `OPENAI_BASE_URL` | no | Chat API host. Defaults to `https://api.openai.com/v1`; overrides must support Responses, Tool Search and Web Search. |
| `OPENAI_MODEL` | no | Chat model. Default `gpt-6-sol`. |
| `OPENAI_REASONING_EFFORT` | no | Chat reasoning effort. Default `medium`; accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` when supported by the model. |
| `OPENROUTER_API_KEY` | no | Enables per-provider automatic tool rules classified by Jev. Without it, new tools stay blocked until an administrator reviews them. |
| `JEV_MODEL` | no | Classifier for automatic tool rules. Default `typesafe/jev-1.13`. |
| `ALLOWED_EMAIL_DOMAINS`, `ALLOWED_EMAILS` | recommended | Who may sign in. The two lists OR together. **Both empty lets any verified Google account in**; the server warns and the sign-in screen says so. |
| `ADMIN_EMAILS` | recommended | Comma-separated exact emails allowed to review and approve discovered tools. **Empty means every tool remains blocked.** |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` | no | Default 3600. |
| `OAUTH_REFRESH_TOKEN_TTL_DAYS` | no | Default 90, slid forward on every use. |
| `OAUTH_ENABLE_CLIENT_ID_METADATA_DOCUMENTS` | no | Default `true`. Advertise CIMD support (the 2026-07-28 replacement for dynamic registration). |
| `BIFROST_DEV_USER_ID` | dev only | UUID accepted from the `X-Bifrost-Dev-User` header when `NODE_ENV=development`. Never set in production. |
| `UPSTREAM_CLIENT_IDLE_SECONDS`, `UPSTREAM_CLIENT_MAX` | no | Pooled upstream MCP clients: idle lifetime (default 300) and per-process cap (default 200). |
| `SLOW_REQUEST_MS`, `SLOW_TOOL_MS` | no | Latency thresholds that turn a log line into a warning. |

## Development

```bash
bun install
npm run dev        # Postgres + Redis containers, migrations, watched API on :3000, Vite on :5173
npm run db:generate # Generate a Drizzle migration after changing src/server/database/schema.ts
npm run verify     # Lint, both typechecks, unit coverage, server/client build
npm run integration -- test  # Postgres + Redis + fake upstream MCP integration tests
npm run build      # Node server to dist/server, React bundle to dist/client
```

Work against <http://localhost:5173>; Vite proxies `/api`, `/auth`, `/oauth` and `/mcp` to the API. `npm run dev` stops the `app` container because both want port 3000. For UI API fixtures, `VITE_USE_MOCK_API=true npm run dev:client` swaps in an in-memory API without starting infrastructure. This is not fully offline: Service status reads real vendor feeds and chat configuration still calls the backend; see [the current preview limitation](docs/verification.md#boot-and-ui-limitations-found-in-this-audit).

For concurrent agents, use the [isolated worktree loop](docs/verification.md):
`npm run worktree -- init 41`, then `npm run worktree -- dev`. Each checkout needs a distinct slot.
That guide also documents the existing development-user header and current boot/preview limitations.

The Docker image bundles its own `dist`, so after changing code, `docker compose up -d --build app`; rebuilding on the host does nothing to a running container.

Unit tests need no database and focus on the places where being wrong is expensive: the prefix invariant, visibility filter, tool fingerprints and policy defaults, PKCE, redirect-URI matching, SSRF address ranges, metadata documents, encryption, log redaction and access rules. Integration tests in `test/integration` run the real MCP path against Postgres, Redis and an in-process fake provider MCP server; CI runs both.

## Layout

```
src/
  app/               React SPA, route-colocated UI and browser entrypoint
  server/            Hono, MCP, OAuth, providers, persistence and Node entrypoint
  features/          cross-runtime product contracts, including the Hono RPC client
migrations/          generated Drizzle SQL, applied on container boot
test/                vitest units; test/integration needs Postgres and Redis
```

[AGENTS.md](AGENTS.md) is the deeper guide for anyone changing the code: request shape, the visibility axes, OAuth details, conventions and the gotchas that cost real time. [docs/adding-a-provider.md](docs/adding-a-provider.md) documents every provider touchpoint.

## Security notes

- Browser sessions (cookie) and agent access (bearer token) resolve against different tables through different functions. A leaked cookie is not an API credential and vice versa.
- Google accounts are bound to the immutable ID-token `sub`. Existing rows link once by verified email on their first post-migration sign-in; later email changes keep the same Bifrost user.
- Provider credentials are bound to their row with AES-GCM associated data and carry a key id, so keys rotate online ([docs/encryption-keys.md](docs/encryption-keys.md)).
- OAuth tokens are opaque and stored as SHA-256 hashes; a replayed refresh token destroys its whole grant, because a replay means the value leaked.
- Expired browser sessions and OAuth tokens are deleted on startup and hourly. Consumed refresh tokens remain until expiry so replay detection keeps working.
- The one server-side fetch of a caller-supplied URL (Client ID Metadata Documents) is HTTPS-only, refuses private and link-local address ranges, follows no redirects, and is capped at 5 s and 64 KB, and it only happens for a signed-in user.
- Logs redact tokens, secrets, cookies, API keys and JWT-shaped strings, and only errors written for the agent are ever returned to it.

## Status

Working and in use for GitHub, Linear, Sentry, Slack, Notion and Granola. One thing is deliberately unbuilt and documented as such in AGENTS.md: OAuth issues a single `mcp` scope rather than per-provider scopes.

# Bifrost

**One MCP endpoint that lets your coding agent use GitHub, Linear, Sentry, Slack and Notion as *you*, without ever holding your tokens.**

You sign in once with Google, connect your own GitHub, Linear, Sentry, Slack and Notion accounts, and point Claude Code (or any MCP client) at `POST /mcp`. From then on the agent reads pull requests, searches issues and posts messages under your identity and permissions, and you decide, tool by tool, what it is allowed to do.

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
                 └──────────────────────────────────────────────────────────┘
```

Three ideas explain most of the design:

1. **The MCP server is rebuilt on every request.** Bifrost loads the caller's connected providers and tool preferences and registers only those tools. A tool that is hidden is not merely absent from `tools/list`, it is uncallable, because it was never registered for that request.
2. **Bifrost is on both sides of OAuth.** It is an OAuth *client* to Google and to each provider (that is how it obtains your tokens), and it is an OAuth 2.1 *authorization server* to MCP clients (that is how Claude Code gets its own credential). Agent access does not silently expire: clients hold a 1-hour access token and a rotating 90-day refresh token.
3. **Two authorities decide what a tool may do.** An administrator must approve the exact fingerprint discovered from the provider, then each user can narrow that approved surface with their own switches.

## What agents get

Tools are discovered from GitHub, Linear, Sentry, Slack and Notion's official MCP servers using each user's OAuth token. Bifrost prefixes their names (`github_`, `linear_`, `sentry_`, `slack_`, `notion_`), preserves their schemas and annotations, and proxies approved calls without exposing provider credentials.

Discovery never grants access by itself. A new tool, or any change to a tool's contract, produces a new fingerprint and stays blocked until an administrator approves that exact version. Missing `readOnlyHint: true` metadata is treated as write-capable.

Discovered catalogs use a one-hour server-side stale-while-revalidate cache. Browser queries receive the remaining server freshness and use it as their own TanStack Query lifetime, so the two caches never add two independent hours. Calls and policy approvals still validate against a fresh upstream definition.

## Quick start

Requirements: Docker with Compose v2, OAuth apps for Google and any GitHub or Slack providers you want, and no application setup for Linear, Sentry or Notion (see [SETUP.md](SETUP.md)).

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
| `PUBLIC_URL` | yes in prod | The origin agents and OAuth redirects use. Default `http://localhost:3000`. |
| `DATABASE_URL` | yes | Postgres. Outside Docker, point it at `localhost:5432`, not `postgres`. |
| `REDIS_URL` | no | Shares locks, rate limits and concurrency leases across workers. Empty degrades to in-process state with a startup warning. |
| `GOOGLE_CLIENT_ID` / `_SECRET` | yes | Sign-in. |
| `GITHUB_*`, `SLACK_*` | per provider | Provider OAuth apps. A provider without credentials still mounts; connecting it fails until they are set. Linear, Sentry and Notion use their MCP servers' dynamic client registration instead. |
| `ALLOWED_EMAIL_DOMAINS`, `ALLOWED_EMAILS` | recommended | Who may sign in. The two lists OR together. **Both empty lets any verified Google account in**; the server warns and the sign-in screen says so. |
| `ADMIN_EMAILS` | recommended | Comma-separated exact emails allowed to review and approve discovered tools. **Empty means every tool remains blocked.** |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` | no | Default 3600. |
| `OAUTH_REFRESH_TOKEN_TTL_DAYS` | no | Default 90, slid forward on every use. |
| `OAUTH_ENABLE_CLIENT_ID_METADATA_DOCUMENTS` | no | Default `true`. Advertise CIMD support (the 2026-07-28 replacement for dynamic registration). |
| `BIFROST_DEV_USER_ID` | dev only | UUID accepted from the `X-Bifrost-Dev-User` header when `NODE_ENV=development`. Never set in production. |
| `SLOW_REQUEST_MS`, `SLOW_TOOL_MS` | no | Latency thresholds that turn a log line into a warning. |

## Development

```bash
npm ci
npm run dev        # Postgres + Redis containers, migrations, watched API on :3000, Vite on :5173
npm run db:generate # Generate a Drizzle migration after changing src/server/database/schema.ts
npm run lint && npm run typecheck && npm test
npm run build      # Node server to dist/server, React bundle to dist/client
```

Work against <http://localhost:5173>; Vite proxies `/api`, `/auth`, `/oauth` and `/mcp` to the API. `npm run dev` stops the `app` container because both want port 3000. For UI work with no backend at all, `VITE_USE_MOCK_API=true npm run dev` swaps in an in-memory API (Service status is never mocked; it reads the vendors' real feeds).

The Docker image bundles its own `dist`, so after changing code, `docker compose up -d --build app`; rebuilding on the host does nothing to a running container.

Tests are pure units, no database, focused on the places where being wrong is expensive: the prefix invariant, visibility filter, tool fingerprints and policy defaults, PKCE, redirect-URI matching, SSRF address ranges, metadata documents, encryption, log redaction and access rules.

## Layout

```
src/
  app/               React SPA, route-colocated UI and browser entrypoint
  server/            Hono, MCP, OAuth, providers, persistence and Node entrypoint
  features/          cross-runtime product contracts, including the Hono RPC client
migrations/          generated Drizzle SQL, applied on container boot
test/                vitest, pure units
```

[AGENTS.md](AGENTS.md) is the deeper guide for anyone changing the code: request shape, the visibility axes, OAuth details, conventions and the gotchas that cost real time. [docs/adding-a-provider.md](docs/adding-a-provider.md) documents every provider touchpoint.

## Security notes

- Browser sessions (cookie) and agent access (bearer token) resolve against different tables through different functions. A leaked cookie is not an API credential and vice versa.
- OAuth tokens are opaque and stored as SHA-256 hashes; a replayed refresh token destroys its whole grant, because a replay means the value leaked.
- The one server-side fetch of a caller-supplied URL (Client ID Metadata Documents) is HTTPS-only, refuses private and link-local address ranges, follows no redirects, and is capped at 5 s and 64 KB, and it only happens for a signed-in user.
- Logs redact tokens, secrets, cookies, API keys and JWT-shaped strings, and only errors written for the agent are ever returned to it.

## Status

Working and in use for GitHub, Linear, Sentry, Slack and Notion. One thing is deliberately unbuilt and documented as such in AGENTS.md: OAuth issues a single `mcp` scope rather than per-provider scopes.

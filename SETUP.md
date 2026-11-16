# Setup

This guide covers the OAuth applications Bifrost needs, production settings, and every
configuration variable.

Use `http://localhost:3000` below for local development. Replace it with the exact HTTPS production origin when registering production applications. OAuth redirect URIs must match exactly.

## 1. Google, Bifrost sign-in

1. In Google Cloud Console, select or create a project.
2. Open **APIs & Services → OAuth consent screen**, configure an Internal app for the company Workspace when possible, and add the intended users.
3. Open **Credentials → Create credentials → OAuth client ID → Web application**.
4. Add `http://localhost:3000/auth/google/callback` under **Authorized redirect URIs**.
5. Put the client ID in `GOOGLE_CLIENT_ID` and the client secret in `GOOGLE_CLIENT_SECRET`.
6. Bifrost requests `openid email profile` and rejects accounts whose email is not verified.

## 2. GitHub

1. In GitHub, open **Settings → Developer settings → OAuth Apps → New OAuth App**. For an organization-owned app, use the organization's **Settings → Developer settings** instead.
2. Set **Homepage URL** to `http://localhost:3000`.
3. Set **Authorization callback URL** to `http://localhost:3000/oauth/github/callback`.
4. Create a client secret. Put the client ID in `GITHUB_CLIENT_ID` and secret in `GITHUB_CLIENT_SECRET`.
5. Requested scopes are `read:user user:email repo`. `repo` is required for private repository PRs, diffs, comments, checks, and issue comments.

## 3. Linear

No Linear application or environment variables are required. When a user connects Linear,
Bifrost registers a public OAuth client with Linear's official MCP authorization server and uses
PKCE with the `read write` scopes. The generated client ID is stored alongside that user's
encrypted credential so refreshes continue to use the same registration.

Connections created with the old Linear application flow keep working until their token expires.
Reconnect Linear once to move them to the MCP-native flow.

## 4. Sentry

No Sentry application or environment variables are required. Bifrost dynamically registers a
public OAuth client with `https://mcp.sentry.dev`, uses PKCE with the `org:read`, `project:write`,
`team:write` and `event:write` scopes, and stores the generated client ID inside the encrypted
credential. Sentry's hosted MCP server owns the upstream Sentry application.

## 5. Notion

No Notion application or environment variables are required. Bifrost dynamically registers a
public OAuth client with `https://mcp.notion.com`, uses PKCE with the `default` scope, and stores
the generated client ID inside the encrypted credential. Notion's hosted MCP server owns the
upstream Notion application.

## 6. Slack

1. Go to <https://api.slack.com/apps>, select **Create New App → From scratch**, and choose the workspace used for testing.
2. Open **OAuth & Permissions**. Add `http://localhost:3000/oauth/slack/callback` under **Redirect URLs**.
3. Under **User Token Scopes**, add the scopes required by Slack's official MCP server: `canvases:read`, `canvases:write`, `channels:history`, `channels:read`, `channels:write`, `chat:write`, `emoji:read`, `files:read`, `groups:history`, `groups:read`, `groups:write`, `im:history`, `im:write`, `mpim:history`, `mpim:read`, `mpim:write`, `reactions:write`, `search:read.files`, `search:read.im`, `search:read.mpim`, `search:read.private`, `search:read.public`, `search:read.users`, `users:read`, and `users:read.email`.
4. Open **Basic Information → App Credentials**. Put **Client ID** in `SLACK_CLIENT_ID` and **Client Secret** in `SLACK_CLIENT_SECRET`.
5. If token rotation is enabled, Bifrost uses the returned user refresh token and serializes refresh through Redis.

## 7. Granola

No Granola application or environment variables are required. Bifrost dynamically registers a
public OAuth client with `https://mcp-auth.granola.ai`, uses PKCE with the `mcp` scope, and stores
the generated client ID inside the encrypted credential. Each user authorizes their own Granola
account in the browser.

## 8. Claude chat

Put an Anthropic API key in `ANTHROPIC_API_KEY` to enable the built-in chat. It
calls Claude through the Vercel AI SDK's Anthropic provider and can run up to 20
model and tool steps per turn. The model defaults to `claude-sonnet-5-5` and
effort to `high`; override them with `ANTHROPIC_MODEL` and `ANTHROPIC_EFFORT`
(`low`, `medium`, `high`, `xhigh` or `max`). Thinking is adaptive, so effort is
the only setting that controls how much the model thinks.

- **Tools.** Bifrost tools are sent with `defer_loading` and found through
  Anthropic's BM25 tool search, so the model does not read every definition on
  every turn. Web search uses Anthropic's server-side `web_search_20260209` tool.
- **Refusals.** Requests opt into server-side fallback (`fallbacks: "default"`):
  when a safety classifier declines a turn, the API retries it on a fallback
  model. If that model declines too, the chat shows that Claude declined the
  request instead of an error.
- **History.** Chat history stays in the browser and is sent back on every turn,
  thinking blocks included. When an earlier turn no longer matches what the model
  saw (an administrator note or the tool list changed), the API drops that
  reasoning and the turn continues.

`ANTHROPIC_BASE_URL` defaults to `https://api.anthropic.com/v1`.

The chat does not need a separate Bifrost token. Its authenticated browser
session resolves the same visible tool set and runs each call through the same
deployment policy, user preference, provider OAuth, rate limit, concurrency
limit, and fresh fingerprint check as `/mcp`.

## 9. Encryption and tool administration

Generate the encryption key outside the repository:

```bash
openssl rand -base64 32
```

Put it in `ENCRYPTION_KEY`. There is intentionally no repository default or Compose fallback. Losing this key makes stored provider credentials unrecoverable. To rotate it, add the new key with `ENCRYPTION_KEYS` and `ENCRYPTION_ACTIVE_KEY_ID`, then re-encrypt the stored rows online with `npm run rotate:credentials`; the procedure is in [docs/encryption-keys.md](docs/encryption-keys.md).

Configure the exact Google email addresses allowed to review provider tools, separated by commas:

```text
ADMIN_EMAILS=admin@example.com,security@example.com
```

Sign in with one of those accounts, connect each provider under **Integrations**, then open **Tool administration**. Every newly discovered tool and every changed contract starts blocked until an administrator approves its current fingerprint. Leaving `ADMIN_EMAILS` empty grants no administrator access and therefore keeps all tools blocked.

## 10. Running in production

`docker-compose.yml` is set up for local use: it defaults to `NODE_ENV=development` and publishes
Postgres and Redis only on `127.0.0.1`. A production deployment must set:

- `NODE_ENV=production`. Bifrost then requires `REDIS_URL` and an `https` `PUBLIC_URL`, and it
  ignores `BIFROST_DEV_USER_ID` and the development header.
- `PUBLIC_URL` to the exact HTTPS origin registered with Google and the providers.

With Compose, put both in `.env` (or the shell environment) before `docker compose up`.

## Configuration reference

All settings are environment variables, validated at startup by `src/server/config.ts`. Leave a
variable out to use its default. `.env.example` is a starting point for local development.

| Variable | Default | What it does |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production`. Production requires `REDIS_URL` and an `https` `PUBLIC_URL`. |
| `PORT` | `3000` | HTTP port the server listens on. |
| `PUBLIC_URL` | `http://localhost:3000` | The origin agents and OAuth redirects use. It is also the OAuth issuer. |
| `LOG_LEVEL` | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`). |
| `DATABASE_URL` | `postgres://bifrost:bifrost@localhost:5432/bifrost` | Postgres. Outside Docker, point it at `localhost:5432`, not `postgres`. |
| `DATABASE_POOL_MAX` | `20` | Postgres connections per process. Multiply by replicas to size `max_connections`. |
| `REDIS_URL` | none | Shared locks, rate limits, concurrency leases, tool catalogs and browser events. Required in production; development and tests fall back to in-process state. |
| `ENCRYPTION_KEY` | none | 32-byte base64 key for provider credentials. Required unless `ENCRYPTION_KEYS` is set. |
| `ENCRYPTION_KEYS`, `ENCRYPTION_ACTIVE_KEY_ID` | none | JSON keyring of key id to base64 key, and the id new writes use. See [docs/encryption-keys.md](docs/encryption-keys.md). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | Google sign-in (section 1). |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | none | GitHub OAuth app (section 2). Without them GitHub still mounts, but connecting fails. |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` | none | Slack app (section 6). Same behavior as GitHub. |
| `ALLOWED_EMAIL_DOMAINS`, `ALLOWED_EMAILS` | empty | Comma-separated lists of who may sign in; they OR together. Both empty lets any verified Google account in. Checked on every request, so removing someone ends their sessions and agent access. |
| `ADMIN_EMAILS` | empty | Comma-separated exact emails that may review tools. Empty keeps every tool blocked. |
| `ANTHROPIC_API_KEY` | none | Turns on the web chat (section 8). |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com/v1` | Anthropic API base for the chat. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Chat model. |
| `ANTHROPIC_EFFORT` | `high` | `low`, `medium`, `high`, `xhigh` or `max`. |
| `OPENROUTER_API_KEY` | none | Turns on automatic tool rules. Without it new tools wait for an administrator. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api` | Base URL for the classifier requests. |
| `JEV_MODEL` | `typesafe/jev-1.13` | Classifier model for automatic tool rules. |
| `OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` | Lifetime of agent access tokens. |
| `OAUTH_REFRESH_TOKEN_TTL_DAYS` | `90` | Lifetime of agent refresh tokens, moved forward on every use. |
| `OAUTH_ENABLE_CLIENT_ID_METADATA_DOCUMENTS` | `true` | Advertise Client ID Metadata Documents, the 2026-07-28 replacement for dynamic registration. |
| `BIFROST_DEV_USER_ID` | none | Development only: a UUID accepted from the `X-Bifrost-Dev-User` header when `NODE_ENV=development`. Never set it in production. See [docs/verification.md](docs/verification.md). |
| `UPSTREAM_CLIENT_IDLE_SECONDS` | `300` | Idle lifetime of a pooled upstream MCP client. |
| `UPSTREAM_CLIENT_MAX` | `200` | Maximum pooled upstream MCP clients per process. |
| `TRUSTED_PROXY_HOPS` | `0` | Number of reverse proxies in front of Bifrost that append to `X-Forwarded-For`. Inbound rate limits use the address the outermost trusted proxy saw; with `0` they use the socket address and ignore the header. |
| `SLOW_REQUEST_MS` | `1000` | Requests slower than this are logged as warnings. |
| `SLOW_TOOL_MS` | `2000` | Tool calls slower than this are logged as warnings. |

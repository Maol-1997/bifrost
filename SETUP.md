# OAuth application setup

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
public OAuth client with `https://mcp.sentry.dev`, uses PKCE, and stores the generated client ID
inside the encrypted credential. Sentry's hosted MCP server owns the upstream Sentry application.

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

## 7. OpenAI chat

Put an OpenAI API key in `OPENAI_API_KEY` to enable the built-in chat. It uses
the Responses API through the Vercel AI SDK and can run up to 20 model and tool
steps per turn. Tool definitions are loaded lazily through Tool Search, grouped
by provider. The model defaults to `gpt-5.6-luna` and reasoning effort defaults
to `medium`; override them with `OPENAI_MODEL` and `OPENAI_REASONING_EFFORT`.

`OPENAI_BASE_URL` defaults to `https://api.openai.com/v1`. An override must be
an OpenAI-compatible API base that supports Responses and Tool Search.

The chat does not need a separate Bifrost token. Its authenticated browser
session resolves the same visible tool set and runs each call through the same
deployment policy, user preference, provider OAuth, rate limit, concurrency
limit, and fresh fingerprint check as `/mcp`.

## 8. Encryption and tool administration

Generate the encryption key outside the repository:

```bash
openssl rand -base64 32
```

Put it in `ENCRYPTION_KEY`. There is intentionally no repository default or Compose fallback. Losing this key makes stored provider credentials unrecoverable; rotating it requires decrypting and re-encrypting every row under controlled operations.

Configure the exact Google email addresses allowed to review provider tools, separated by commas:

```text
ADMIN_EMAILS=admin@example.com,security@example.com
```

Sign in with one of those accounts, connect each provider under **Integrations**, then open **Tool administration**. Every newly discovered tool and every changed contract starts blocked until an administrator approves its current fingerprint. Leaving `ADMIN_EMAILS` empty grants no administrator access and therefore keeps all tools blocked.

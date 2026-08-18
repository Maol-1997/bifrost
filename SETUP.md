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

1. In Linear, open **Workspace settings → API → OAuth applications → Create new**.
2. Set the callback URL to `http://localhost:3000/oauth/linear/callback`.
3. Put the generated values in `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`.
4. Enable these scopes: `read`, `write`, `issues:create`, and `comments:create`.
5. Linear may rotate refresh tokens. Bifrost serializes each user's refresh with a Redis lock and persists the replacement before releasing the lock.

## 4. Slack

1. Go to <https://api.slack.com/apps>, select **Create New App → From scratch**, and choose the workspace used for testing.
2. Open **OAuth & Permissions**. Add `http://localhost:3000/oauth/slack/callback` under **Redirect URLs**.
3. Under **User Token Scopes**, add `channels:read`, `groups:read`, `channels:history`, `groups:history`, `search:read`, and `chat:write`.
4. Open **Basic Information → App Credentials**. Put **Client ID** in `SLACK_CLIENT_ID` and **Client Secret** in `SLACK_CLIENT_SECRET`.
5. If token rotation is enabled, Bifrost uses the returned user refresh token and serializes refresh through Redis.

## 5. Encryption and write policy

Generate the encryption key outside the repository:

```bash
openssl rand -base64 32
```

Put it in `ENCRYPTION_KEY`. There is intentionally no repository default or Compose fallback. Losing this key makes stored provider credentials unrecoverable; rotating it requires decrypting and re-encrypting every row under controlled operations.

Write tools are blocked by default. Configure exact allowed names in the deployment environment, outside agent control, for example:

```text
WRITE_TOOL_ALLOWLIST=github_create_issue_comment,linear_add_comment
```

Available write names are `github_create_issue_comment`, `linear_create_issue`, `linear_add_comment`, and `slack_post_message`.

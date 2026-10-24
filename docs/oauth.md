# OAuth: Bifrost is on both sides

This trips people up. Bifrost is simultaneously:

- **An OAuth client**, to Google (sign-in) and to GitHub/Linear/Sentry/Slack/Notion (provider connections).
  That is `src/server/oauth.ts`.
- **An OAuth 2.1 authorization server plus resource server**, to MCP clients like Claude Code.
  That is all of `src/server/oauth-server/` and it implements the MCP `2026-07-28` authorization spec.

The agent-facing half is why agent access does not expire the way a static key would: the client
holds a short access token (1h) and a rotating refresh token (90d, slid forward on each use), and
replaces its own credential without anyone being asked to log in again.

Google sign-in binds a Bifrost user to the ID token's immutable `sub`; email remains mutable profile
and access-policy data. Rows created before this field existed link once by their verified email on
the first post-migration sign-in. A later email collision with another subject is rejected rather
than merging accounts.

## The client side

The client side uses `openid-client` for authorization URLs, PKCE, provider code exchanges and
refresh grants. Linear, Sentry, Notion and Granola dynamically register public clients against their official MCP
authorization servers; their generated client IDs are stored inside the encrypted provider credential.
Sentry, Notion and Granola expose OAuth Authorization Server metadata, so their discovery must use the `oauth2`
algorithm. GitHub and Slack still use configured applications. Slack's user grant is normalized in
`providers/slack-oauth.ts` because Slack nests
it under `authed_user` instead of returning the standard top-level token fields. Google token
verification deliberately remains on `jose`: Google documents two valid `iss` forms, while
`openid-client` correctly enforces one exact configured issuer.

Two invariants on provider connections:

- **A provider callback must be finished by the account that started it.** The state names the
  starting user; `finishProvider` compares it with the browser session delivering the callback and
  refuses a mismatch before exchanging the code. Otherwise handing someone the authorization URL
  would connect their provider account to yours.
- **A refresh never resurrects or overwrites a connection.** Refreshed tokens are written with
  `replaceCredentialIfUnchanged`, which only lands over the exact row the refresh started from (the
  encrypted payload's IV is the version). A disconnect or reconnect that happened during the
  exchange wins, and the token just obtained is dropped.

## The authorization server side

Worth knowing before touching `src/server/oauth-server/`:

- **Dynamic Client Registration is deprecated** in 2026-07-28, replaced by Client ID Metadata
  Documents. Both paths are implemented; `OAUTH_ENABLE_CLIENT_ID_METADATA_DOCUMENTS` decides
  which one clients take, because advertising support is what makes them choose.
- **Refresh tokens rotate with replay detection.** A spent token presented again destroys the
  entire grant rather than just declining, because a replay means the value leaked.
- **Disconnecting a client also voids its unredeemed authorization codes.** Codes cannot be
  enumerated, so `oauth-server/revocation.ts` remembers the revocation for the code lifetime and
  the token endpoint rejects any code issued before it.
- **Expired credentials are housekeeping-bounded.** Startup and hourly maintenance remove expired
  sessions, access tokens and refresh tokens. Consumed refresh tokens stay until their own expiry so
  replay detection remains available for the full validity window.
- **Tokens are opaque, stored as SHA-256 hashes.** Not JWTs: this gives instant revocation and no
  key management, and the bearer regex in `authenticateAgent()` would not match a JWT's dots anyway.
- **`redirect-uri.ts` implements the RFC 8252 loopback port exception.** It looks like a
  loophole and is not: Claude Code publishes `http://localhost/callback` with no port and binds an
  ephemeral one at runtime, so without this its CIMD flow cannot complete.
- **`ssrf.ts` guards CIMD fetches**, which are server-side fetches of a URL the caller supplies.
  HTTPS only, IP range checks, no redirects, 5s timeout, 64KB cap.
- **Never log token or auth-code values.** The logger takes ids, never material.

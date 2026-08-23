# OAuth: Bifrost is on both sides

This trips people up. Bifrost is simultaneously:

- **An OAuth client**, to Google (sign-in) and to GitHub/Linear/Sentry/Slack/Notion (provider connections).
  That is `src/server/oauth.ts`.
- **An OAuth 2.1 authorization server plus resource server**, to MCP clients like Claude Code.
  That is all of `src/server/oauth-server/` and it implements the MCP `2026-07-28` authorization spec.

The agent-facing half is why agent access does not expire the way a static key would: the client
holds a short access token (1h) and a rotating refresh token (90d, slid forward on each use), and
replaces its own credential without anyone being asked to log in again.

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

## The authorization server side

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

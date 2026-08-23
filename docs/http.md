# HTTP architecture

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

`users.google_subject` is the immutable Google identity key. It is nullable only for legacy and
development rows; a real Google login sets it before issuing a session. Browser sessions can only
be renewed by the browser that owns their cookie, so the renewal response extends the row and emits
the matching 30-day cookie together.

`GET /healthz` returns `503` whenever configured Redis is not ready. Production requires
`REDIS_URL`, so load balancers remove a replica whose shared coordination state is unavailable.

Preference tables store **only deviations from the default**, keyed `(user_id, thing)`. Absence
of a row is meaningful, so never backfill them.

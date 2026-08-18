# Bifrost

Bifrost is one internal MCP endpoint for user-attributed GitHub, Linear, and Slack tools. It keeps provider credentials server-side, encrypts them with AES-256-GCM, and filters discovery and calls by provider health, connection state, user preferences, and endpoint policy.

The human endpoint is `POST /mcp`. The reserved service endpoint, `POST /mcp/internal`, deliberately returns `501` until service-account identity and per-service prefix allowlists are implemented.

## Local start

Requirements: Docker with Compose v2.

```bash
cp .env.example .env
# Put the output into ENCRYPTION_KEY in .env. Do not commit it.
openssl rand -base64 32
docker compose up --build
```

Open <http://localhost:3000>. Provider app registration is documented in [SETUP.md](SETUP.md).

The application refuses to start without a valid 32-byte base64 `ENCRYPTION_KEY`. Write tools start off for every user and only work once that user enables them in Integrations. `WRITE_TOOL_ALLOWLIST` is a deployment ceiling on top of that: name tools there and no other write tool can be enabled at all, leave it empty and there is no ceiling. The server logs a warning at startup when none is set.

Sign-in is gated by `ALLOWED_EMAIL_DOMAINS` and `ALLOWED_EMAILS`, which OR together: domains for the team, exact addresses for anyone outside them. The check runs before the user row is created, so a rejected account leaves nothing behind, and it is enforced on the last `@` of the address so `you@allowed.dev@evil.com` cannot pass. With both empty any verified Google account may sign in; the server logs a warning at startup and the sign-in screen states that plainly rather than implying a restriction.

## Development

```bash
npm ci
npm run dev        # everything: Postgres, Redis, watched API, Vite UI
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run dev` starts the Postgres and Redis containers, applies migrations, then runs the API under `tsx watch` on port 3000 and Vite on port 5173. Work against <http://localhost:5173>; it proxies `/api`, `/auth`, `/oauth`, and `/mcp` to the API. It also stops the `app` container, because that container and the watched API both want port 3000. Use `docker compose up --build` when you want to exercise the production image instead.

`npm run build` produces the Node server and the static React application. The Node server serves the client bundle and its SPA routes from the same deployment.

Migrations run automatically when the app container boots, so `docker compose up` needs no extra step. `npm run migrate` is for running the server outside Docker; it reads `DATABASE_URL` from `.env`, which must point at `localhost:5432` rather than the compose-internal `postgres` host.

For frontend-only design work without a running API, use `VITE_USE_MOCK_API=true npm run dev`. Production builds use the real connection endpoints unless that variable is explicitly enabled. Service status has no mock at any time: it reads the vendors' own public feeds, so faking it would defeat the only purpose that screen has.

For local MCP verification without live Google credentials, set `BIFROST_DEV_USER_ID` to a UUID and send that same value in `X-Bifrost-Dev-User`. This path only exists when `NODE_ENV=development`; never configure it in production.

## Surfaces

- `POST /mcp`: modern MCP `2026-07-28`, human identity only.
- `POST /mcp/internal`: explicit `501` service-path stub.
- `GET /api/status.json`: mount status and tool counts.
- `GET /api/app-connections.json`: authenticated user's connections and hidden preferences.
- `GET /api/provider-health.json`: each vendor's own uptime feed (GitHub, Linear and Notion are Statuspage tenants; Slack has its own API). Public, because it is the one screen you need when you cannot sign in; a one-minute single-flight cache, not authentication, is what keeps it from amplifying traffic onto the upstream status pages.
- `GET /api/clients.json`: the caller's live sessions, with `isCurrent` marking the browser making the request.
- `GET /api/me.json`: the signed-in user's name and email. The client treats a `401` as "nobody is signed in" rather than redirecting, so the public status screen stays readable when sign-in is unavailable.
- `POST /api/clients/:kind/:id/revoke` and `/renew`, where `:kind` is `browser` or `agent`: both scoped by `user_id`, so an id from one account can never touch another's. Only browser sessions can be renewed (agents keep themselves connected through OAuth refresh), and renewal is refused once a session has expired — that browser has to sign in again.
- `GET /`: the React SPA. Its own router lands on `/integrations`.
- `GET /healthz`: container health.

Every MCP request emits structured JSON fields for user ID, client ID, JSON-RPC method, optional tool name, latency, status code, and request ID. Tool calls have independent latency logging. Redis coordinates OAuth refresh rotation, outbound starts, and in-flight concurrency across workers; without Redis the same safeguards degrade to process-local state with a warning.

## Protocol decision

The official TypeScript SDK v2 split packages (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`, and `@modelcontextprotocol/core`) implement the `2026-07-28` stateless protocol. Bifrost uses `createMcpHandler` with `legacy: 'reject'`, so there is no initialize handshake or `Mcp-Session-Id`.

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

The application refuses to start without a valid 32-byte base64 `ENCRYPTION_KEY`. Write tools are denied unless their exact names appear in `WRITE_TOOL_ALLOWLIST`.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

For local MCP verification without live Google credentials, set `BIFROST_DEV_USER_ID` to a UUID and send that same value in `X-Bifrost-Dev-User`. This path only exists when `NODE_ENV=development`; never configure it in production.

## Surfaces

- `POST /mcp`: modern MCP `2026-07-28`, human identity only.
- `POST /mcp/internal`: explicit `501` service-path stub.
- `GET /api/status.json`: mount status and tool counts.
- `GET /api/app-connections.json`: authenticated user's connections and hidden preferences.
- `GET /`: server-rendered status and connection links.
- `GET /healthz`: container health.

Every MCP request emits structured JSON fields for user ID, client ID, JSON-RPC method, optional tool name, latency, status code, and request ID. Tool calls have independent latency logging. Redis coordinates OAuth refresh rotation, outbound starts, and in-flight concurrency across workers; without Redis the same safeguards degrade to process-local state with a warning.

## Protocol decision

The official TypeScript SDK v2 split packages (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`, and `@modelcontextprotocol/core`) implement the `2026-07-28` stateless protocol. Bifrost uses `createMcpHandler` with `legacy: 'reject'`, so there is no initialize handshake or `Mcp-Session-Id`.

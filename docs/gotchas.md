# Gotchas that cost real time

- **Vite does not discover route files.** Every new route entry must be registered in
  `src/app/app.tsx` and `src/features/utils/routes.ts`; server SPA fallbacks derive from that manifest.
- **The Docker image contains its own copy of `dist`.** Rebuilding on the host does nothing to a
  running container. Deploying a change means `docker compose up -d --build app`. Forgetting this
  looks exactly like a change that did not work.
- **Port 3000 is contested.** `npm run dev` stops the `app` container because the watched server
  wants the same port. Before killing whatever holds 3000, identify the process first — that port
  is also held by the Docker proxy, and killing it blindly takes the whole daemon down.
- **Dev work happens on `:5173`, not `:3000`.** Vite proxies `/api`, `/auth`, `/oauth` and `/mcp`
  to the API.
- **`npm run migrate` outside Docker needs `DATABASE_URL` on `localhost:5432`**, not the
  compose-internal `postgres` host.
- **Never rename a constraint in an already-applied migration.** Rolling back to fix it destroys
  real rows. Write a new migration, or `ALTER ... RENAME CONSTRAINT` in place.
- `ENCRYPTION_KEY` has no dev default by design and the server refuses to start without it.
- `REDIS_URL` is mandatory in production. Redis owns distributed tool catalogs, browser events,
  locks and limits, so silently falling back to per-process state would make replicas disagree.

## Known gaps

Honest state, so nobody rediscovers these as bugs:

- OAuth issues a single `mcp` scope. Per-provider scopes are the natural next axis, which is why
  grants store a `text[]` rather than one string.
- Bifrost logs `userId` in the clear on every MCP call. Hashing it in logs would be an
  improvement if an audit trail is ever built.

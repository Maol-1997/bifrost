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
  Removing a key from `ENCRYPTION_KEYS` before `npm run rotate:credentials` reports no rows under
  it makes those credentials unreadable. See [encryption-keys.md](encryption-keys.md).
- **Only the provider refresh waits for a held Redis lock.** A second request refreshing the same
  credential waits up to 12 seconds and then reuses the first one's token. Every other
  `Coordinator.withLock` caller still fails fast on purpose: the maintenance sweep skips, automatic
  rules report busy, and key rotation counts the row as busy.
- `REDIS_URL` is mandatory in production. Redis owns distributed tool catalogs, browser events,
  locks and limits, so silently falling back to per-process state would make replicas disagree.

- **Worktrees need distinct ports and state.** Use `npm run worktree -- init <slot>` and
  `npm run worktree -- dev`, not the fixed-port default. See [verification.md](verification.md).
- **Source and built OAuth rendering can differ.** Consent rendering has failed with `React is not defined`
  from the tsx dev runner on Node 25.6.1; the compiled server completes consent successfully.
- **Mock API mode still reads live chat configuration.** Its 401 can redirect mocked screens to
  sign-in because the chat stays mounted off-route. A mock user is not a real server session.

- **A pooled upstream session can expire between calls.** The provider then answers 404 and the
  pool resends that one request on a fresh connection. Any other failure, a 5xx or a timeout,
  reaches the agent unrepeated, because the provider may already have run the call. Each pooled
  client may also keep the SDK's GET event stream open.
- **"Sessions" last-used times can lag by up to a minute.** The bearer check only stamps
  `last_used_at` and the user agent when the stored stamp is over 60 seconds old.

## Known gaps

Honest state, so nobody rediscovers these as bugs:

- OAuth issues a single `mcp` scope. Per-provider scopes are the natural next axis, which is why
  grants store a `text[]` rather than one string.
- Bifrost logs `userId` in the clear on every MCP call. Hashing it in logs would be an
  improvement if an audit trail is ever built.

# Frontend architecture

The app uses a route-colocation model: React Router registers URLs explicitly in
`src/app/app.tsx`; the folders organize ownership and do not create routes.

- **A file lives at the closest folder that is an ancestor of every consumer.** Route-only code
  stays under that route. Code used by multiple routes moves to `app/components`, `app/lib` or
  `app/api`. Cross-runtime product contracts and code used by both sides belong in `features`.
- **The route tree mirrors the URL.** Each route owns a `<domain>.tsx` entry at its root and,
  when needed, `components/`, `hooks/` and `utils/`. Dynamic segments use bracket folders such as
  `integrations/[providerId]/` even though React Router, not Vite, interprets the parameter.
- **Do not create one-line route wrappers.** Vite gives `page.tsx` no special behavior, so
  `app.tsx` lazy-loads each route entry directly. Re-export-only modules are allowed only when
  a real package boundary needs a deliberate public API.
- **The root tree must describe product boundaries, not framework buckets.** Do not recreate
  root-level `pages/`, `components/`, `hooks/`, `lib/` or client `api/` folders.
- **Single-file items stay flat.** Create an item folder only when it has companions such as a
  test, types or a reducer. `index.ts` may only re-export; never define code in a barrel and never
  create `index.tsx`.
- **No nested item folders.** Items sit one level below their owning `components`, `hooks` or
  `utils` folder.
- **Filenames are kebab-case.** React symbols use PascalCase and hooks/functions use camelCase.
- **Aliases cross scopes; relative imports stay inside a scope.** Use `@app/*` and `@features/*`
  across boundaries. A route's screen imports its local components with `./...`; never import
  through its own barrel.
- **TanStack Query owns remote state.** Use `useQuery`/`useMutation` instead of fetching in
  effects. Shared query options live in `app/api/query-options.ts`; route-only query behavior
  stays with that route. Invalidate the narrow shared key after mutations, and use optimistic
  updates only when rollback is explicit.
- **Dates use `date-fns`.** Keep ISO timestamps across the HTTP boundary and format them in the
  browser so local time stays honest. Do not add another hand-written date arithmetic helper.
- **Browser APIs use Hono RPC.** Keep route registrations chained so `AppType` retains their input
  and response schemas. Consume them through `src/features/bifrost-api/client.ts`; do not recreate URL,
  body or response DTOs in the app. `parseRpcResponse` owns authenticated 401 behavior.

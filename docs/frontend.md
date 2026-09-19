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
- **The persisted cache belongs to one account.** Only the providers query is persisted to
  IndexedDB (`app/api/persister.ts`). The snapshot is restored before anyone is known to be signed
  in, so the app shell claims it for the current account once `current-user` resolves and drops a
  snapshot that belonged to someone else. Sign-out and the 401 path clear it and stop further
  writes, since a throttled save could otherwise land after the clear.
- **TanStack Query owns remote state.** Use `useQuery`/`useMutation` instead of fetching in
  effects. Shared query options live in `app/api/query-options.ts`; route-only query behavior
  stays with that route. Invalidate the narrow shared key after mutations, and use optimistic
  updates only when rollback is explicit.
- **Dates use `date-fns`.** Keep ISO timestamps across the HTTP boundary and format them in the
  browser so local time stays honest. Do not add another hand-written date arithmetic helper.
- **Browser APIs use Hono RPC.** Keep route registrations chained so `AppType` retains their input
  and response schemas. Consume them through `src/features/bifrost-api/client.ts`; do not recreate URL,
  body or response DTOs in the app. `parseRpcResponse` owns authenticated 401 behavior.

## Design system rules

`npm run lint` (also part of `npm run verify`) enforces all six `@shadcn/lint` rules as
errors on `src/app`. Configuration lives in `eslint.config.js`; component/theme discovery
uses `components.json`.

- **Component ownership:** consumers may control layout, but use variants for colors,
  padding, shape, and animation. Button height comes from `size`, not `h-*`/`size-*`.
  Use `variant="warning"` for reconnect actions, `variant="underline"` on tab lists/triggers,
  and Skeleton's `variant`/`shape` for loading treatments.
- **Composition contracts:** surfaces, settings rows, and sidebar containers accept spacing.
  Settings row titles/descriptions accept typography; descriptions also allow tertiary,
  quaternary, and warning text colors. Rows may dim via opacity. Group-wrapped settings
  links use `variant="grouped"`; chat hosts may request a transparent background.
- **Theme values:** use declared colors, typography, radii, and spacing utilities instead of
  hardcoded appearance values. Arbitrary layout values remain allowed for responsive geometry.
  Prefer Tailwind's standard font-size scale: `text-xs` (12px) for small labels and details,
  `text-sm` (14px) for body text. Use the nearest standard size instead of adding a custom
  token just to preserve a fractional pixel value. Hairlines and focus outlines have
  `linear-*` utilities; do not round the deliberate half-pixel borders to 1px.
- **Analyzable classes:** use complete class names or static conditional alternatives, not
  interpolated names or opaque imported class values on UI components. Unknown classes fail lint.
- **Inline styles:** use classes; pass dynamic measurements through CSS custom properties.
  Only the specific width/left/opacity/transform properties needed by sidebar and tooltip
  React Spring integrations are exempted on their animated elements.

Inside `components/ui`, implementations own their styling, so `no-restyle`,
`no-arbitrary-values`, and `require-static-classes` are disabled there. Color, class-existence,
and inline-style checks still apply. Add variants for intentional component treatments,
not as a place to hide route-specific overrides.

Exceptions are narrow and named in ESLint: original registry SVGs and the standalone Bifrost
mark keep their brand colors; component-local CSS selectors and Sonner's `toaster` marker are
allowed only in their owning files. Version 0.1 misclassifies some custom shadow tokens as
colors, so those exact names are exempt from the color rule. Revisit those exceptions when
upgrading. CSS files themselves are not linted by this plugin, and a clean lint run does not
establish visual quality or runtime behavior.

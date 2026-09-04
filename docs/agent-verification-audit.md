# Agent DX and verification-loop audit

Audited base: `673eb31`; branch `audit/agent-dx`; worktree
`/Users/maol/WebstormProjects/Maol/bifrost-wt-dx`. Experiments used Node 25.6.1 on macOS,
the locked dependencies, Postgres 17 and Redis 8. The Node 22 Docker image was not rebuilt;
source-runner findings must also be reproduced there before choosing a fix.

## Executive finding

The largest gap is **no supported deterministic, authenticated full-stack fixture environment**,
not an absence of development authentication. `BIFROST_DEV_USER_ID` already seeds a user and
allows a matching header on browser and MCP routes. With that existing path, the compiled HTTP
server completes OAuth 2.1 end to end without a Google account. Provider mounting, real cookie
sign-in, browser previews and chat are not joined into one repeatable loop.

Implemented only the authorized low-risk pieces: isolated worktree infrastructure and commands,
`npm run verify`, 19 security-boundary unit cases, and these docs. No fake auth, provider registry
refactor, integration tier, CI job, or production auth change was implemented.

## Friction log: experiments 1–8

| Step | Tried and observed | Proof / limitation |
| --- | --- | --- |
| 1. Fresh boot | Created required worktree; `npm ci` succeeded (4 moderate audit entries). `npm run dev` failed at Compose interpolation because `ENCRYPTION_KEY` was unset. Copied template and generated key; Docker daemon was stopped, so started OrbStack. Original Compose then collided on host Redis port 6379. New isolated stack started and migrations passed. A blank `OPENAI_BASE_URL` from the template caused `AI_InvalidArgumentError` during import. Removed only that local blank assignment. | Five setup/remediation actions after install before a healthy isolated API: template/key, daemon start, port isolation, removing blank SDK URL, launch/migrate. These are environment-specific frictions, not a universal step count. API boots with key + DB + Redis and no OAuth apps; also boots with Redis omitted. Google start returns 500 without apps; unauthenticated MCP returns 401 plus discovery challenge. |
| 2. Three change loops | Temporarily changed server `/healthz` status to `dx-audit-ok`; a source-run process returned the marker over HTTP. Changed SPA fallback wildcard in `src/features/utils/routes.ts`; two existing route tests failed. Changed the sign-in link text; Playwright found the new accessible link and saved a screenshot. Restored every probe. | All three had behavioral proof, not just typecheck. No committed browser suite verifies React routes or Hono RPC interoperability. A first health probe raced the watch restart and got connection refused; subsequent bounded readiness polling on a separate process worked. |
| 3. Agent MCP access | Set the existing dev UUID and matching header; seeded user returned `/api/me.json` with admin status when its generated email was allowlisted. Naive `tools/list` failed first for protocol version, then envelope keys, then missing `Mcp-Method`. Used all required headers and `_meta` fields. | Real MCP serialization/listing succeeds with an empty catalog. No Google needed. No fixture provider or approved tools come with the seed. Existing `http-app.test.ts` replaces `mcpHandler.fetch` for its success test and therefore misses these wire requirements. |
| 4. OAuth 2.1 | HTTP dynamic registration returned 201/no-store. Both `node --import tsx` and the actual `npm run dev:server` runner returned 500 on consent: log says `React is not defined`. Built server returned consent HTML; posted one-time approval, exchanged code with S256 PKCE, used bearer token on `/mcp`, rotated refresh, replayed spent refresh and confirmed replacement access token gets 401. Repeated successfully with Redis omitted. | Real Postgres grant issuance, refresh and replay revocation work locally on compiled server. Browser identity for consent was the existing header, not a minted cookie; Google callback and session issuance remain unproved. Source runtime failure is invisible to the passing unit renderer tests/build. |
| 5. Fake provider | Created an experimental local MCP echo server; passed a custom `ProviderDefinition` with existing `github` ID directly to `listUpstreamTools` and `callUpstreamTool`. First strict-modern fake rejected the client's default 2025 handshake; allowing legacy stateless traffic produced deterministic echo over real HTTP. | Low-level transport accepts a double. Normal registry/discovery/execution imports are hard-coded; arbitrary `fake` ID cannot typecheck or mount without touching ID unions, maps, validation and limits. This experiment did not replace the live registry or seed credentials/policy. Default upstream client negotiation is legacy; do not assume every SDK-v2 client talks the modern wire format automatically. |
| 6. UI | Public sign-in renders. Mock Vite exposes mock user but both Integrations and Chat redirect to sign-in: `Chat` is mounted even off-route and live `/api/chat/config.json` returns 401. SwiftCode preview status/open/snapshot all returned automation failures. Used temporary standalone Playwright instead (not installed in repo). Scoped dev header to audit origin and captured real Integrations, Chat and admin-tools pages. | Screenshots possible without Google, with custom automation setup. No Storybook, component preview command or Playwright config. Chat honestly displays "Chat is not configured". No live chat/tool interaction tested; status feed remains external. |
| 7. Tests/coverage | Baseline 34 files / 379 tests pass; selected coverage 91.83% statements, 87.59% branches. Added 19 boundary cases: 398 pass, selected coverage 98.34% / 90.55%. Ran a separate broad server-coverage experiment with thresholds disabled for measurement only. | Unit strengths are real, but selected denominator omits DB grant/session implementations and MCP assembly. See table. No DB tests were added; regular thresholds unchanged. |
| 8. Observability | Pino structured logs/redaction, Hono `X-Request-Id`, MCP method/status/latency/user/client logs and tool execution correlation exist. `/healthz`, public mounted-provider status, user connection catalog and admin provider-tool endpoints exist. Google/consent exceptions log a generic HTTP error with message but no request ID. | No resolved-visibility reason dump, replay CLI, or all-request completion logger. `/healthz` is Redis-aware but does not query Postgres or prove Google/chat readiness. An HTTP 200 alone is not proof of successful JSON-RPC; inspect `result` versus `error`. |

The original compose file's `app` interpolation applies even when requesting only infrastructure.
Different directory-based Compose project names isolate volume/network names but not fixed host
ports. Explicitly sharing a project instead shares containers and data; `dev:infra` can stop its
`app` from any checkout. Reusing one Redis index also mixes ephemeral codes, locks, limits,
catalogs and the global browser-event channel, even if PostgreSQL database names differ.

## Coverage: measured risk, not just percentage

S/B = statement / branch percentages. "Expanded" numbers come from the same 398 unit tests with
`src/server/**` included, not from manual HTTP experiments. A 100% branch figure on code whose
functions never ran is not transaction coverage; inspect function/statement counts.

| Module | Baseline S/B | After S/B | Specific remaining blind spots |
| --- | --- | --- | --- |
| `src/server/http/auth.ts` | 94.50 / 91.17 | 97.80 / 94.11 | Session-cookie clearing (62–63); forwarded user-agent/null-resolution variants. Added wrong-resource rejection and dev header rejection in production/test and for wrong UUID. Real session expiry/revocation is a store-tier gap. |
| `src/server/oauth-server/authorize.ts` | 74.47 / 72.00 | 96.35 / 88.23 | Fresh/expired CIMD cache orchestration, actual metadata fetch + persistence (218–222), propagation of unexpected resolver errors (83–84), omitted state/resource/scope variants. Added successful consent creation, deleted user, existing grant, unregistered/disabled client, signed-out pre-fetch/consent checks. |
| `src/server/oauth-server/token.ts` | 79.59 / 85.71 | 97.95 / 94.28 | Non-OAuth storage errors during token exchange (28–29), empty revoke body and optional resource variants. Added registration persistence/rejection/storage failure and required grant fields. Rotation outcome tests still mock the DB. |
| `src/server/oauth-server/clients.ts` | 100 / 96.22 | 100 / 96.29 | Empty response body reader; absent/default cache-control branches (133,168). Handler CIMD cache lifecycle needs integration proof. |
| `src/server/oauth-server/ssrf.ts` | 100 / 80 | 100 / 80 | Defensive IPv6 parser/fallback branches (75–91,101), some unreachable after `isIP` validation. Real DNS/network isolation not covered by mocked fetch tests. |
| `src/server/oauth-server/{pkce,redirect-uri,metadata}.ts` | 100 / 100 | 100 / 100 | No measured unit gaps; cross-endpoint binding and actual transport still require integration. |
| `src/server/security/{access,secrets}.ts` | 100 / 100 | 100 / 100 | No measured unit gaps. AES wrong-key, IV/tag/ciphertext tampering, unknown version covered already. Encrypted database persistence/restart is not covered. |
| `src/server/tools/filter.ts` | 100 / 100 | 100 / 100 | All helper axes covered; composition of mounted/connected/hidden/fingerprint/default/preference under real per-user DB state is not. |
| `src/server/tools/catalog.ts` | 96.96 / 88 | 96.96 / 88 | Invalid normalized snapshot (90–91), removed contract-field diff (131–133), normalization/array edge branches. |
| `src/server/database/oauth-grants.ts` | Excluded | Expanded 11.86 / 100; functions 8.33 | Every store operation unexecuted: token issuance/hashing, row locks, refresh replay/concurrent rotation/expiry, audience lookup, revocation/cascades, maintenance. Manual OAuth experiment exercises only a subset, outside coverage. |
| `src/server/database/sessions.ts` | Excluded | Expanded 28.35 / 100; functions 12.50 | All seven returned methods unexecuted: create, resolve/touch, delete/expiry, list, ownership-scoped revoke/renew; only factory/constants loaded. |
| `src/server/mcp.ts` | Excluded | Expanded 37.73 / 100; functions 40 | Per-request factory, real registration callback/execution and handler error path unexecuted. |
| `src/server/tools/user-toolset.ts` | Excluded | Expanded 81.35 / 76.92 | `loadVisibleUserTools` never invoked by units; slow/error logging and invalidation-failure branches incomplete. |
| `src/server/http/browser.ts` | Excluded | Expanded 39.91 / 75 | Admin authorization/mutations, real cookie session lifecycle, connected discovery and full chat boundary mostly unexecuted. |

Baseline coverage came from the committed configuration, not an assumption that encryption/auth
were untested. Adding redundant crypto tests would be lower value than testing actual DB semantics.

## Prioritized proposals

Effort: S = hours/about one day; M = a few days; L = roughly a week or more including boundary review.
Commands below are **proposed unless marked implemented**.

### P0a — Fix known boot/preview regressions (S)

- **Friction:** a documented fresh environment crashes on blank SDK URL; dev consent renderer differs
  from test/build; mock UI silently exits to sign-in.
- **Files:** `.env.example`, `docker-compose.yml` (never inject a blank SDK URL); `package.json` and
  a dedicated `tsconfig.server-dev.json` if an explicit source-runner configuration fixes JSX;
  `src/app/api/bifrost.ts` (mock chat configuration); `src/app/chat/chat.tsx` (avoid unnecessary
  off-route request only if that preserves intended persistent chat behavior); startup/preview smoke fixtures.
- **One command:** `npm run smoke:boot` starts the exact dev command with template-only settings,
  polls health, fetches a consent page, opens mock Integrations, and asserts no sign-in redirect.
- Reproduce on Node 22 and Node 25; do not fix `React is not defined` by importing React into Hono
  views. A successful compile does not validate the tsx transform used by the dev runner.

### P0b — Supported local fixture environment, no external OAuth (L; owner sign-off)

- **Friction:** existing dev header seeds only identity, not browser session, deterministic tools,
  policies, chat or repeatable cleanup. A developer must hand-assemble the rest.
- **One command:** `DEV_FAKE_AUTH=true npm run dev` after worktree initialization; ordinary
  `npm run dev` without the flag retains real authentication. The dispatcher uses the isolated
  infrastructure wrapper whenever `.worktree/env` exists.
- **New files:** `src/server/dev/main.ts`, `src/server/dev/guard.ts`, `src/server/dev/seed.ts`,
  `src/server/dev/routes.ts`, `src/server/dev/provider.ts`, `src/server/dev/chat-model.ts`,
  `src/server/runtime.ts` (dependency assembly with explicit registry/upstream injection),
  `scripts/dev.sh`, `test/dev-guard.test.ts`.
- **Changed files:** `package.json`, `tsconfig.build.json`, `Dockerfile`, `src/server/main.ts`,
  `src/server/config.ts`, `src/server/http/{app,context,browser,public}.ts`,
  `src/server/providers/{types,registry}.ts`, `src/server/tools/{discovery,user-toolset}.ts`,
  `src/server/oauth.ts`, `src/server/chat.ts`, `src/app/api/{types,catalog,bifrost}.ts`, provider
  route/icon handling under `src/app/integrations/`, `.env.example`, docs.
- **Identity:** fixed fixture UUID + `admin@development.invalid` and one non-admin/second user;
  use the real session store and HttpOnly cookie, not an agent bearer in a browser cookie. Local
  bootstrap sets a session then redirects to Integrations. Disable Google/provider external OAuth
  in fixture mode. Do not silently approve arbitrary real providers or tools.
- **Provider seam:** inject a runtime provider registry and upstream discovery/call interface
  consistently through assembly, discovery, execution, status and route validation. Add a clearly
  labeled `fixture_` namespace, with separate production-provider ID/maps and dev-only registry;
  preserve duplicated app/server ID types rather than crossing runtime boundaries. Existing DB
  provider columns are text, so no enum migration is required. Production registry never mounts it.
- **Tools:** `fixture_echo`, `fixture_add`, `fixture_fail` with deterministic schemas/results; seed
  approved fingerprints for the first two and block the third. Add one harmless fixture write to
  test mutability/default-off behavior. Seed connections for the fixture only, and offer local
  connect/disconnect for QA. Test changing a contract keeps it blocked until explicitly approved.
- **Chat:** inject a deterministic local model/tool-call response in the excluded dev entry;
  do not route fake tools through a paid OpenAI call. Keep the real chat handler/visibility path.
- **Environment/guards:** `DEV_FAKE_AUTH` boolean default false, `DEV_FIXTURE_SCENARIO` from a fixed
  enum (`connected`, `disconnected`, `blocked`), `DEV_FIXTURE_DATABASE_NAME` restricted to
  `bifrost_dev_<worktree-hash>`, and random per-run `DEV_BOOTSTRAP_TOKEN` generated in private local
  state, never in tracked files or logs. Never accept arbitrary fixture/user IDs from URLs.
- **Production impossibility:** separate excluded dev entry; production main must *always reject*
  `DEV_FAKE_AUTH=true`, even if someone sets `NODE_ENV=development`. Dev entry additionally requires
  `NODE_ENV=development`, exact loopback bind/public origin, local Docker fixture DB/Redis URLs,
  and the named fixture DB marker. Bind HTTP to `127.0.0.1`, validate Host/Origin on bootstrap, and
  require a per-run bootstrap capability; no shared LAN auto-login. Exclude all dev implementations
  from emitted server files and the runtime Docker image. Test the actual image with both NODE_ENV
  values and fake flag: it must fail/404, never enable bootstrap. Do not rely on NODE_ENV alone:
  current compose explicitly overrides the production image with development mode.
- **Existing dev header:** remove its bypass from production assembly or make it require the same
  explicit dev-entry capability; tests should prove `BIFROST_DEV_USER_ID` cannot re-enable it in a
  built runtime with NODE_ENV overridden. This guard migration is why owner review is necessary.
- **Acceptance:** no network to Google, providers or OpenAI; boot yields signed-in fixture admin;
  reset affects only marked fixture DB; external Host/non-loopback URL/wrong DB marker/production
  flags fail before creating users; second user has independent visibility; cookie never authorizes
  MCP and bearer never authorizes browser API; fake namespace absent from production image/routes.

### P1 — Real HTTP + real storage integration tier (L; owner sign-off)

- **Friction:** database-free mocks cannot prove FK constraints, transaction races, atomic refresh
  replay, migration compatibility, real MCP registration or cookie expiry.
- **New files:** `test/integration/{session,mcp-visibility,oauth-flow,refresh-race}.integration.test.ts`,
  `test/integration/{global-setup,harness,fixtures}.ts`, `vitest.integration.config.ts`,
  `.github/workflows/verify.yml`; optional `scripts/integration.sh` for provisioning.
- **Changed:** root `vitest.config.ts`, `package.json`, `AGENTS.md`, `docs/conventions.md` and
  `docs/verification.md`; include integration configs in `tsconfig.json` so typed lint can parse them.
- **One command:** `npm run test:integration` provisions isolated Postgres/Redis containers using
  Testcontainers (preferred dynamic ports), applies real Drizzle migrations, starts real Hono app,
  and tears down only its own containers. If using Compose instead, require the worktree wrapper
  and create a unique `bifrost_test_<run-id>` DB; reject the normal application DB URL.
- **Policy reconciliation:** keep `test/*.test.ts` as project `unit` with **no database/network**;
  integration files only in project `integration`; use explicit includes and `npm test` selects
  unit. Keep coverage thresholds for unit unchanged; integration has separate output/thresholds.
  Root coverage configuration remains root-owned (Vitest 3 project limitation).
- **CI:** independent Node 22 unit/build job and Docker integration job; migration setup cannot
  read production secrets. Upload coverage/logs on failure; retain no plaintext tokens. A later
  browser job depends on the fixture service. No existing CI file is present in the audited base.
- **Cases:** create real browser session via a stubbed verified-Google identity callback or dev
  bootstrap and then **drop the dev header**; real cookie attributes/expiry/touch/renew/revoke;
  two users with different provider connections; all five visibility axes; missing/stale policy,
  user-enabled blocked tool, hidden provider, admin-only chat tools absent from `/mcp`;
  discover/list/call via installed SDK; auth code+S256 PKCE+state+issuer+resource, wrong client,
  wrong verifier, expired/replayed code, consent-user mismatch; refresh rotation, two concurrent
  rotations and replay revoking the whole grant; revoked tokens cannot reach MCP; Redis code
  consumed across two app instances; encrypted credential restart round-trip.
- Pin tests to actual protocol configuration or use an SDK with explicit modern negotiation;
  never substitute `mcpHandler.fetch` in the success path. Add source-runner and built-server
  smoke variants so the observed JSX discrepancy cannot recur unnoticed.

### P1 — Browser smoke / screenshot tier (M after fixtures)

- **Friction:** typecheck/build do not prove navigation, forms, auth redirects, or chat/tool UI;
  mock API is incomplete and the integrated browser may be unavailable.
- **New:** `playwright.config.ts`, `test/e2e/agent-smoke.spec.ts`,
  `test/e2e/fixtures.ts`; **changed:** `package.json`, `.gitignore`, CI, TS/lint config ownership
  for the Playwright config, and `docs/verification.md`.
- **One command:** `npm run test:e2e`. Playwright `webServer` owns fixture startup/readiness;
  `reuseExistingServer: false` in CI and isolated origin/ports per worker.
- **Flow:** bootstrap cookie -> Integrations -> disconnect/reconnect fixture -> review exact
  policy -> open Agent -> deterministic prompt triggers `fixture_echo` -> visible tool/result;
  navigate admin and sessions routes; fresh reload retains expected identity, never Google.
- Save success screenshots at named checkpoints and trace/screenshot on failure under
  `artifacts/qa/<run-id>/`; assert accessible roles/text, JSON responses and absence of page errors.
  Mock vendor status at test transport only for determinism; keep product status route live.
  Retain an optional real-provider manual smoke but never require external accounts for core CI.

### P2 — Worktree isolation (S, implemented)

- **Friction:** host port collisions, shared DB/cache/event state, stopping another checkout's app.
- **Files:** `scripts/worktree.sh`, `scripts/compose.worktree.yml`, `vite.config.ts`,
  `package.json`, `.gitignore`, `docs/verification.md`.
- **One command after init:** `npm run worktree -- dev`; first run uses
  `npm run worktree -- init 41`. Independent containers/volumes avoid Redis-index/PubSub ambiguity.
- Verified real isolated start/migrate/status; Vite selected 5041 and proxy target 3041. Original
  fixed-port stack failed on 6379. `init` refuses existing settings and invalid slot 0. No volumes
  are deleted by `down`. Port allocation is explicit, not a racy "pick a free port" claim.

### P2 — Explain visibility and correlate/replay requests (M)

- **Friction:** an empty catalog does not explain unmounted/disconnected/hidden/stale/blocked/off;
  HTTP exceptions are hard to join to requests; MCP wire probes require rediscovery of headers.
- **New:** `src/server/tools/visibility-report.ts`, `src/server/dev/debug-tools.ts`,
  `scripts/replay-mcp.sh`, `test/visibility-report.test.ts`; **changed:**
  `src/server/tools/user-toolset.ts`, `src/server/http/{app,context,mcp}.ts`, `src/server/logger.ts`,
  `package.json`, docs. Prefer a local CLI first, not another network auth boundary.
- **One command:** `npm run debug:tools -- --user <uuid>` through worktree environment; report JSON
  with provider/tool/fingerprint, policy/default/user override, effective visibility and **all**
  applicable reasons: unmounted, disconnected, hidden, discovery-failed, missing-policy,
  changed-fingerprint, blocked, default-off, user-disabled. Reuse enforcement resolver; no second
  approximate policy implementation, no auto-approval or token output. Cached mode by default;
  explicit `--refresh` means an outbound read.
- Hono request-scoped child logger carries request ID/method/path (omit query), propagates to
  OAuth/browser/tool helpers, and emits completion status/latency even on errors. Startup/maintenance
  have operation IDs, not invented HTTP request IDs. Preserve structured redaction and do not log
  bodies/cookies/codes. Add unit correlation/redaction assertions.
- `npm run debug:replay -- --request <redacted-json>` targets only configured loopback fixture origin;
  use installed MCP SDK or construct the full modern envelope, get a fresh local fixture identity,
  reject non-fixture/write calls unless explicitly selected. Never capture bearer/cookies or
  automatically retry a write. Admin HTTP equivalent, if later needed, must use browser admin
  identity and be absent from `/mcp`, with no-store and no secret fields.

### P2 — One honest verification entry point (S now, M for future tiers)

- **Implemented:** `scripts/verify.sh`, `package.json`, `AGENTS.md`, `docs/conventions.md`.
  **Command:** `npm run verify`. Sequential lint/typecheck/unit/build, stage summary and nonzero
  failure. Verified failure short-circuit using a temporary npm shim; no test stage ran after a
  simulated typecheck failure.
- **Follow-up:** support `npm run verify -- --full` only once integration/e2e exist; full means
  static/unit/build + integration + e2e and fails if any tier/service is missing. Default remains
  cheap and database-free. No successful "full" result with skipped Docker/browser tiers.

### P2 — Agent instructions (S, implemented current state; future draft below)

- **Friction:** had to discover header seed, synthetic email/admin configuration, complete MCP
  envelope, source-vs-built renderer mismatch, selective coverage, mock chat leak and port ownership.
- **Files:** `AGENTS.md`, `README.md`, `docs/{conventions,gotchas,verification}.md`.
- **One command:** `npm run verify`, with current versus proposed proof explicitly separated.
  Keep runtime recipes in one document and links elsewhere; do not tell agents a placeholder test
  tier exists. Do not instruct agents to weaken auth/filtering to obtain screenshots.

## Draft future replacement: AGENTS.md Verification

Adopt this only after integration/e2e and `--full` are implemented:

> Run `npm run verify` before every commit (lint, server/app typechecks, database-free unit tests
> with coverage, server/client build). For changes to auth, OAuth, persistence, MCP/tool visibility
> or browser flows, also run `npm run verify -- --full` (real HTTP/Postgres/Redis integration and
> Playwright smoke against isolated deterministic fixtures). A missing service/browser is a failed
> required tier, not permission to claim success.
>
> `test/*.test.ts` is unit-only and must not access a database or network.
> `test/integration/**/*.integration.test.ts` uses disposable databases/Redis and the real HTTP app.
> `test/e2e/**/*.spec.ts` uses the local fixture environment, never personal provider accounts.
> Run focused commands while iterating: `npm test`, `npm run test:integration`, `npm run test:e2e`.
> Report commands, results, coverage scope and screenshot/trace artifact paths. A passing typecheck
> is not runtime proof. Initialize a distinct worktree slot and use `npm run worktree -- dev`;
> see `docs/verification.md` for environment, cleanup and protocol recipes.

## Evidence and source references

Local untracked artifacts are retained under `.worktree/`: baseline/expanded coverage, sanitized
experiment logs, experiment source as `.txt`, `app-mutation.png`, `live-sign-in.png`,
`mock-integrations.png`, `mock-chat.png`, `seeded-integrations.png`, `seeded-chat.png`, and
`seeded-admin-tools-github.png`. Screenshots intentionally include only synthetic local identity;
OAuth token material was kept in process memory, not emitted in reports.

`npm ci` audit: four moderate entries form one dev-tool chain (`drizzle-kit` ->
`@esbuild-kit/esm-loader` -> `@esbuild-kit/core-utils` -> `esbuild`). No force upgrade was applied.
Build warns about large client chunks; not a failed check or a new regression in this branch.

Implementation planning checked primary docs: Compose project naming scopes resources but does
not allocate host ports ([Docker](https://docs.docker.com/compose/how-tos/project-name/)); Vitest 3
supports separated projects with root-owned coverage ([Vitest projects](https://v3.vitest.dev/guide/projects),
[coverage](https://v3.vitest.dev/guide/coverage)); Playwright supports managed web-server readiness
and screenshot/trace artifacts ([webServer](https://playwright.dev/docs/test-webserver),
[artifact options](https://playwright.dev/docs/test-use-options)). All repository findings above
come from this checkout and experiments, not web descriptions of the project.

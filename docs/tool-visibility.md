# Tool visibility

Which tools an agent sees depends on who is asking; there is no single global tool list.
Filtering is enforcement, not display: see [request-lifecycle.md](request-lifecycle.md).

## The axes that can hide a tool

`visibleTools` (`src/server/tools/filter.ts`) fails closed on each axis independently:

1. The provider mounted at startup.
2. The user has a `provider_credentials` row for it.
3. The user has not hidden the provider in Integrations.
4. The exact discovered fingerprint has an approved deployment policy.
5. The policy default or the user's own preference enables the tool.

Deployment policy has three states: `blocked`, `allowed_default_off`, and `allowed_default_on`.
No row, a missing tool, or a fingerprint mismatch is always `blocked`. Administrators listed in
`ADMIN_EMAILS` review these policies under `/admin/tools/:providerId`; batch changes are committed
atomically and rejected when any submitted fingerprint is stale.

User preferences store only deviations from the approved deployment default. This keeps deployment
approval and user choice as separate authorities and makes absence meaningful.

## Admin tools stay off `/mcp`

The built-in web chat adds a separate `bifrost_admin` tool namespace only when the cookie-backed
browser identity belongs to an address in `ADMIN_EMAILS`. Those tools can inspect providers and
atomically update deployment policies, but they are never registered by `createHumanMcpHandler` and
therefore never appear on `/mcp`. Keep that boundary: external agents must not receive administrative
capabilities through their OAuth grants.

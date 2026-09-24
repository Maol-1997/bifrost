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

Policy writes reconcile those deviations in the same transaction. A new fingerprint or blocked
tool clears all prior user choices; otherwise rows equal to the new default are removed. Both the
HTTP admin screen and chat administration use the same write path and broadcast Redis-backed browser
invalidations after commit.

## Automatic rules

An administrator may give a provider one plain-language rule in `/admin/tools/:providerId`, such as
"only tools that create, edit, merge or push files to a pull request". When the server has
`OPENROUTER_API_KEY`, every tool definition the rule has not decided yet is classified against it by
Jev (`JEV_MODEL`, via OpenRouter's decisions API) and written as a deployment policy with
`source = 'auto'`. Users never see the rule; they see the resulting defaults and can override them.

- Probability `≥ 0.8` becomes `allowed_default_on`; anything lower becomes `allowed_default_off`,
  and `0.2 < p < 0.8` is flagged as uncertain on the admin screen. A rule never writes `blocked`,
  so with a rule in place, tools outside it are available to users but off by default.
- Pending means: no policy, a fingerprint that changed, or an `auto` policy from an older rule
  revision. An administrator's decision on the current fingerprint is never overwritten; the
  conditional upsert in `setAutoToolPolicies` enforces that even under races.
- It fails closed. Without a key, without a rule, or when classification fails for any tool in the
  batch, nothing is written and new definitions stay `blocked`. Failures back off for five minutes
  per rule revision.
- Classification is triggered from discovery (`onFreshTools`) in the background, so it never delays
  `/mcp`, and synchronously when the administrator saves a rule. The HTTP route and the admin chat
  tools (`bifrost_admin_get/set/clear_mcp_tool_rule`) share `saveToolRule` and `clearToolRule`. Removing a rule keeps the policies
  it already wrote.
- Only tool definitions leave the server: name, title, description, read/write and parameter
  names. Descriptions are provider-written, so the question tells Jev that nothing inside them is
  part of the rule.

## Admin tools stay off `/mcp`

The built-in web chat adds a separate `bifrost_admin` tool namespace only when the cookie-backed
browser identity belongs to an address in `ADMIN_EMAILS`. Those tools can inspect providers,
atomically update deployment policies and read or change each provider's automatic rule, but they are never registered by `createHumanMcpHandler` and
therefore never appear on `/mcp`. Keep that boundary: external agents must not receive administrative
capabilities through their OAuth grants.

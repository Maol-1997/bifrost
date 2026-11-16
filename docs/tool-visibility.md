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
`OPENROUTER_API_KEY`, every new tool definition is classified against it by
Jev (`JEV_MODEL`, via OpenRouter's decisions API) and written as a deployment policy with
`source = 'auto'`. Users never see the rule; they see the resulting defaults and can override them.

- Probability `≥ 0.8` becomes `allowed_default_on`; anything lower becomes `allowed_default_off`,
  and `0.2 < p < 0.8` is flagged as uncertain on the admin screen. A rule never writes `blocked`,
  so with a rule in place, tools outside it are available to users but off by default.
- Pending means: no policy for that tool name yet, or an `auto` policy on the same fingerprint from
  an older rule revision. Nothing else is ever pending:
  - An administrator's decision (`source = 'admin'`) is never overwritten, for any fingerprint. An
    administrator's `blocked` therefore sticks to the tool name even when the provider changes the
    contract.
  - A changed contract is never reclassified, whether the old policy came from an administrator or
    from the rule. The fingerprint mismatch keeps it `blocked` and the admin screen marks it
    "Contract changed" until a person approves the new fingerprint. A rule can therefore never raise
    a changed tool above its previous state.
  - The conditional upsert in `setAutoToolPolicies` repeats these conditions in SQL, so they hold
    even when an administrator writes between the read and the write.
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

The chat model reads web search results and provider tool output in the same loop, and any of that
text can try to steer it. So every admin tool that changes policies or rules
(`ADMIN_TOOLS_REQUIRING_APPROVAL`: set policies, set rule, clear rule) uses the AI SDK's
`toolApproval`. The call stops with an approval request, the chat shows the exact change (every tool
and state in a batch, or the full rule text), and nothing runs until the administrator presses
**Approve**. **Deny** returns a denial to the model instead. The fingerprint check still runs when the
approved call executes, so a definition that changed while the request waited rejects the batch.
Notes and read-only admin tools run without approval.

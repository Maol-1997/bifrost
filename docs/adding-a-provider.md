# Adding a provider

Adding a provider should be mechanical. If a mounted tool does not appear, prefix drift or visibility state is usually the cause.

## Required touchpoints

1. Add the provider ID to `ProviderId` in `src/providers/types.ts`.
2. Add `src/providers/<provider>.ts` with one `ProviderDefinition` and focused wrapper tools. Every tool name must start with the provider's one prefix. Mark each tool `read` or `write`.
3. In `src/providers/registry.ts`, add the provider in all four aligned locations: `PROVIDER_NAMESPACES`, `SUPPORTED_APPS`, `CREDENTIAL_PROVIDER_BY_PREFIX`, and `PROVIDER_REGISTRY`.
4. Add client ID and client secret variables to `src/config.ts`, `.env.example`, and `docker-compose.yml`.
5. Add provider-specific token-response normalization only when the standard OAuth response shape is insufficient. Never log token responses.
6. Add the OAuth registration steps, callback URL, scopes, and environment-variable names to `SETUP.md`.
7. Add outbound rate and concurrency limits in `src/mcp.ts`.
8. Add prefix-invariant and visibility-filter coverage.

## Rules

- A provider owns exactly one lowercase prefix ending in `_`.
- Registration, namespace, supported-app connection lookup, and credential mapping must use the identical prefix and provider ID.
- Provider modules expose explicit wrapper tools, not dynamic upstream pass-through.
- Inputs are Zod-validated before execution.
- A write tool starts off for every user and stays off until they enable it in Integrations. If the
  deployment sets `WRITE_TOOL_ALLOWLIST`, only the exact names listed there can be enabled at all;
  an empty allowlist is no ceiling rather than a blanket denial.
- Credentials only cross the isolated AES-256-GCM storage boundary in `src/security/secrets.ts` and `src/db.ts`.
- Refresh-token rotation uses `Coordinator.withLock` with a user-and-provider key.

## Mounted but invisible

Check these in order:

1. Did startup pass `assertPrefixInvariant`? A one-character mismatch must stop the process.
2. Is the provider mount marked healthy in `/api/status.json`?
3. Does the current user have a `provider_credentials` row for the exact provider ID?
4. Is the provider hidden in `user_provider_preferences`?
5. Is the prefix internal-only, or is an internal caller missing its per-service prefix allowance?
6. Does the requested tool name exactly match the registered wrapper name?

Do not weaken the filter to diagnose visibility. Each axis fails closed deliberately.

## Validation checklist

- [ ] Startup invariant passes and fails under an intentional one-character prefix drift test.
- [ ] Read and write annotations match actual upstream behavior.
- [ ] Required OAuth scopes are minimal and documented.
- [ ] OAuth connect, callback, encrypted persistence, refresh, reconnect-required, and disconnect paths are covered.
- [ ] Connected user sees tools; unconnected and hidden users do not.
- [ ] Unmounted providers expose no tools.
- [ ] Write call is denied until the user enables it, and a non-empty allowlist admits it only by exact name.
- [ ] Rate limit and concurrency values are set.
- [ ] Typecheck, lint, tests, build, Compose start, MCP discovery, and encrypted restart round-trip pass.

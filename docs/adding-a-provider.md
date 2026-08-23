# Adding a provider

Adding a provider connects Bifrost to the provider's official Streamable HTTP MCP server. Bifrost discovers that server's tools at runtime, so no tool wrappers or duplicated schemas belong here.

## Required touchpoints

1. Add the provider ID to `ProviderId` in `src/server/providers/types.ts`.
2. Add `src/server/providers/<provider>.ts` with one `ProviderDefinition`: OAuth endpoints and scopes, the official HTTPS MCP URL, one Bifrost prefix, and `readAccountLabel` when its token can read an identity endpoint.
3. In `src/server/providers/registry.ts`, add the provider in `PROVIDER_NAMESPACES`, `SUPPORTED_APPS`, `CREDENTIAL_PROVIDER_BY_PREFIX`, and `PROVIDER_REGISTRY`.
4. Add the frontend `ProviderId`, catalog entry and route guard, then generate its logo with `npx shadcn@latest add @svgl/<slug> --path src/app/components/ui/svgs --yes` and register it in `ProviderIcon`.
5. For a static OAuth client, add its ID and secret to `src/server/config.ts`, `.env.example`, and `docker-compose.yml`. For DCR, declare the issuer discovery algorithm and persist the generated client ID with the encrypted credential.
6. Add token-response normalization only when the standard OAuth shape is insufficient. Never log token responses.
7. Document OAuth registration, callback URL, scopes, and any environment variables in `SETUP.md`.
8. Add outbound rate and concurrency limits in `src/server/mcp.ts`, plus the provider's public status feed when one exists.
9. Add prefix-invariant, discovery, fingerprint, policy, and visibility coverage.

## Rules

- Use only the provider's official MCP endpoint, over HTTPS.
- A provider owns exactly one lowercase prefix ending in `_`. Registry namespace, credential lookup and discovered tool names must use that same prefix.
- Preserve upstream schemas and annotations. `readOnlyHint === true` is read-only; missing or false metadata is write-capable.
- Never approve a tool from discovery alone. No stored policy, a missing tool, or a fingerprint mismatch means blocked.
- Before each call, reload the upstream definition and require the approved fingerprint to still match.
- Discovery uses the shared per-user SWR cache. A successful reconnect and disconnect must invalidate the provider entry; approval and execution bypass it.
- Credentials only cross the AES-256-GCM storage boundary in `src/server/security/secrets.ts` and `src/server/database/connections.ts`.
- Refresh-token rotation uses `Coordinator.withLock` with a user-and-provider key.

## Mounted but invisible

Check these in order:

1. Did startup pass `assertPrefixInvariant`?
2. Is the provider mounted in `/api/status.json`?
3. Does the current user have a `provider_credentials` row for the exact provider ID and all current required scopes?
4. Can Bifrost reach the official MCP endpoint with that user's token?
5. Has an administrator approved the exact current fingerprint?
6. Is the provider hidden, or did the user switch the tool off?

Do not weaken the filter or policy checks to diagnose visibility. Each axis fails closed deliberately.

## Validation checklist

- [ ] Startup invariant detects an intentional prefix drift.
- [ ] OAuth connect, callback, encrypted persistence, refresh, reconnect-required, and disconnect paths work.
- [ ] Official tools are discovered with schemas and annotations intact.
- [ ] Missing `readOnlyHint: true` is classified as write.
- [ ] New and changed fingerprints remain blocked.
- [ ] Admin batch updates are atomic and reject stale fingerprints.
- [ ] Connected and approved users see tools; unconnected, hidden, blocked, and disabled users do not.
- [ ] A definition change between discovery and execution aborts the call.
- [ ] Rate and concurrency limits are set.
- [ ] Typecheck, lint, tests, build, Compose start, MCP discovery, and encrypted restart round-trip pass.

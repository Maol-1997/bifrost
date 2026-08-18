import { CREDENTIAL_PROVIDER_BY_PREFIX } from '../providers/registry.js';
import type { ProviderDefinition, ProviderId, ProviderMount, ToolDefinition } from '../providers/types.js';

export type UserToolVisibility = {
  connectedProviders: ReadonlySet<ProviderId>;
  hiddenProviders: ReadonlySet<ProviderId>;
  /**
   * Tools this caller does not get, by name. Because the MCP server is rebuilt
   * per request, dropping a tool here is the whole enforcement: it never reaches
   * `tools/list` and calling it by name finds nothing to call.
   */
  disabledTools: ReadonlySet<string>;
};

export function visibleTools(
  providers: readonly ProviderDefinition[],
  mounts: readonly ProviderMount[],
  visibility: UserToolVisibility,
): readonly ToolDefinition[] {
  const mounted = new Set(mounts.filter((mount) => mount.isMounted).map((mount) => mount.providerId));
  return providers.flatMap((provider) => {
    const mappedProvider = CREDENTIAL_PROVIDER_BY_PREFIX[provider.prefix];
    if (!mounted.has(provider.id) || mappedProvider !== provider.id) return [];
    if (!visibility.connectedProviders.has(provider.id) || visibility.hiddenProviders.has(provider.id)) return [];
    return provider.tools.filter((tool) => !visibility.disabledTools.has(tool.name));
  });
}

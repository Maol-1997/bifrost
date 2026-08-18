import { CREDENTIAL_PROVIDER_BY_PREFIX, INTERNAL_ONLY_PREFIXES } from '../providers/registry.js';
import type { ProviderDefinition, ProviderId, ProviderMount, ToolDefinition } from '../providers/types.js';

export type UserToolVisibility = {
  connectedProviders: ReadonlySet<ProviderId>;
  hiddenProviders: ReadonlySet<ProviderId>;
  endpoint: 'human' | 'internal';
  internalAllowedPrefixes?: ReadonlySet<string>;
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
    if (INTERNAL_ONLY_PREFIXES.has(provider.prefix) && visibility.endpoint !== 'internal') return [];
    if (visibility.endpoint === 'internal' && !visibility.internalAllowedPrefixes?.has(provider.prefix)) return [];
    return [...provider.tools];
  });
}

export function findVisibleTool(
  name: string,
  providers: readonly ProviderDefinition[],
  mounts: readonly ProviderMount[],
  visibility: UserToolVisibility,
): ToolDefinition | undefined {
  return visibleTools(providers, mounts, visibility).find((tool) => tool.name === name);
}

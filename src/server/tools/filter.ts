import type { ProviderId, ProviderMount } from '../providers/types.js';
import type { DiscoveredTool } from './catalog.js';

export type UserToolVisibility = {
  connectedProviders: ReadonlySet<ProviderId>;
  hiddenProviders: ReadonlySet<ProviderId>;
  enabledTools: ReadonlySet<string>;
};

export function visibleTools(
  tools: readonly DiscoveredTool[],
  mounts: readonly ProviderMount[],
  visibility: UserToolVisibility,
): readonly DiscoveredTool[] {
  const mounted = new Set(mounts.filter((mount) => mount.isMounted).map((mount) => mount.providerId));
  return tools.filter((tool) => (
    mounted.has(tool.providerId)
    && visibility.connectedProviders.has(tool.providerId)
    && !visibility.hiddenProviders.has(tool.providerId)
    && visibility.enabledTools.has(tool.name)
  ));
}

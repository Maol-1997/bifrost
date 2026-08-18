import { z } from 'zod';
import type { ProviderDefinition, ProviderId, ProviderMount } from './types.js';
import { githubProvider } from './github.js';
import { linearProvider } from './linear.js';
import { slackProvider } from './slack.js';

export const PROVIDER_NAMESPACES = {
  github: 'github_',
  linear: 'linear_',
  slack: 'slack_',
} as const satisfies Record<ProviderId, `${ProviderId}_`>;

export const SUPPORTED_APPS = ['github', 'linear', 'slack'] as const satisfies readonly ProviderId[];

export const CREDENTIAL_PROVIDER_BY_PREFIX = {
  github_: 'github',
  linear_: 'linear',
  slack_: 'slack',
} as const satisfies Record<(typeof PROVIDER_NAMESPACES)[ProviderId], ProviderId>;

export const INTERNAL_ONLY_PREFIXES = new Set<string>();

export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = [githubProvider, linearProvider, slackProvider];

/** The four places a prefix is spelled. Each defaults to the real one; tests substitute a drifted copy. */
export type PrefixInvariantInputs = {
  registry?: readonly ProviderDefinition[];
  namespaces?: Readonly<Record<string, string>>;
  apps?: readonly string[];
  credentialMapping?: Readonly<Record<string, string>>;
};

export function assertPrefixInvariant({
  registry = PROVIDER_REGISTRY,
  namespaces = PROVIDER_NAMESPACES,
  apps = SUPPORTED_APPS,
  credentialMapping = CREDENTIAL_PROVIDER_BY_PREFIX,
}: PrefixInvariantInputs = {}): void {
  const problems: string[] = [];
  for (const provider of registry) {
    if (namespaces[provider.id] !== provider.prefix) problems.push(`${provider.id}: namespace differs from registry prefix`);
    if (!apps.includes(provider.id)) problems.push(`${provider.id}: missing from supported apps`);
    if (credentialMapping[provider.prefix] !== provider.id) problems.push(`${provider.id}: credential mapping differs from prefix`);
    for (const tool of provider.tools) {
      if (!tool.name.startsWith(provider.prefix)) problems.push(`${provider.id}: tool ${tool.name} has wrong prefix`);
    }
  }
  if (new Set(registry.map((provider) => provider.prefix)).size !== registry.length) problems.push('provider prefixes are not unique');
  if (problems.length > 0) throw new Error(`Provider prefix invariant failed: ${problems.join('; ')}`);
}

/**
 * A provider mounts only if every tool carries a real Zod schema: the MCP
 * server hands that schema to clients and validates input against it, so a
 * tool without one would advertise arguments it cannot check.
 */
export function mountProviders(): readonly ProviderMount[] {
  return PROVIDER_REGISTRY.map((provider) => {
    const unschematizedTool = provider.tools.find((tool) => !(tool.inputSchema instanceof z.ZodType));
    return unschematizedTool
      ? { providerId: provider.id, isMounted: false, error: `${unschematizedTool.name} has no input schema` }
      : { providerId: provider.id, isMounted: true };
  });
}

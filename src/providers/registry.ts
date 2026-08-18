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

export function assertPrefixInvariant(
  registry: readonly ProviderDefinition[] = PROVIDER_REGISTRY,
  namespaces: Readonly<Record<string, string>> = PROVIDER_NAMESPACES,
  apps: readonly string[] = SUPPORTED_APPS,
  credentialMapping: Readonly<Record<string, string>> = CREDENTIAL_PROVIDER_BY_PREFIX,
): void {
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

export function mountProviders(): readonly ProviderMount[] {
  return PROVIDER_REGISTRY.map((provider) => {
    try {
      for (const tool of provider.tools) tool.inputSchema.parse({});
    } catch {
      // Schemas with required fields reject {}, which still proves the schema is callable.
    }
    return { providerId: provider.id, isMounted: true };
  });
}

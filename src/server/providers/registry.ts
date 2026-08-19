import type { ProviderDefinition, ProviderId, ProviderMount } from './types.js';
import { granolaProvider } from './granola.js';
import { githubProvider } from './github.js';
import { linearProvider } from './linear.js';
import { notionProvider } from './notion.js';
import { sentryProvider } from './sentry.js';
import { slackProvider } from './slack.js';

export const PROVIDER_NAMESPACES = {
  granola: 'granola_',
  github: 'github_',
  linear: 'linear_',
  notion: 'notion_',
  sentry: 'sentry_',
  slack: 'slack_',
} as const satisfies Record<ProviderId, `${ProviderId}_`>;

export const SUPPORTED_APPS = ['github', 'linear', 'sentry', 'slack', 'notion', 'granola'] as const satisfies readonly ProviderId[];

export const CREDENTIAL_PROVIDER_BY_PREFIX = {
  granola_: 'granola',
  github_: 'github',
  linear_: 'linear',
  notion_: 'notion',
  sentry_: 'sentry',
  slack_: 'slack',
} as const satisfies Record<(typeof PROVIDER_NAMESPACES)[ProviderId], ProviderId>;

export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = [githubProvider, linearProvider, sentryProvider, slackProvider, notionProvider, granolaProvider];

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
  }
  if (new Set(registry.map((provider) => provider.prefix)).size !== registry.length) problems.push('provider prefixes are not unique');
  if (problems.length > 0) throw new Error(`Provider prefix invariant failed: ${problems.join('; ')}`);
}

export function mountProviders(): readonly ProviderMount[] {
  return PROVIDER_REGISTRY.map((provider) => {
    const url = new URL(provider.mcpUrl);
    return url.protocol === 'https:'
      ? { providerId: provider.id, isMounted: true }
      : { providerId: provider.id, isMounted: false, error: 'Official MCP endpoint must use HTTPS' };
  });
}

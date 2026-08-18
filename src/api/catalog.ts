import type { ConnectableProviderId, Provider, ProviderId } from './types';

/**
 * The curated prose the screens need: what an app is, and what connecting it
 * actually lets your agents do.
 *
 * Carries no tools on purpose. Every claim below is checked against the tools
 * the server really registers, because this text is the promise a user reads
 * before handing over access — an aspirational version of it is a lie, not a
 * placeholder. `neverPermission` says "Bifrost has no tool that does" rather
 * than "it cannot": the OAuth scopes are broader than the tools, and the tool
 * surface is the boundary that is actually enforced.
 */
export const providerCatalog: readonly Omit<Provider, 'tools'>[] = [
  {
    id: 'github', name: 'GitHub', monogram: 'G', description: "Where your team's code and code reviews live.", status: 'connected', isHidden: false,
    permissions: ['Read pull requests, their diffs and their review comments', 'See whether CI checks passed', 'Comment on an issue or pull request as you'],
    neverPermission: 'Your agents can never push code, merge, create branches or pull requests, or change settings — Bifrost has no tool that does.',
    successCapabilities: ['Read pull requests, diffs and review comments', 'Check whether CI passed', 'Comment on issues and pull requests — in your name'],
  },
  {
    id: 'linear', name: 'Linear', monogram: 'L', description: 'Where projects and tasks are tracked.', status: 'needs-reconnect', isHidden: false,
    permissions: ['Search and read issues, and list your teams and projects', 'Create issues and post comments as you'],
    neverPermission: 'Your agents can never edit or delete an existing issue, or change workspace settings — Bifrost has no tool that does.',
    successCapabilities: ['Search and read issues, teams and projects', 'Create issues and comments — in your name'],
  },
  {
    id: 'slack', name: 'Slack', monogram: 'S', description: 'Where the team talks.', status: 'not-connected', isHidden: false,
    permissions: ['List channels and read their history, threads included', 'Search messages you can already see', 'Post a message as you'],
    neverPermission: 'Your agents can never read your direct messages, join channels, or delete anything — Bifrost has no tool that does.',
    successCapabilities: ['List channels and read history and threads', 'Search messages you can already see', 'Post messages — in your name'],
  },
  {
    id: 'notion', name: 'Notion', monogram: 'N', description: 'Where docs and notes live.', status: 'unavailable', isHidden: false,
    permissions: ['Nothing yet — Bifrost has no Notion tools'],
    neverPermission: 'Connecting it is not possible yet, so it grants nothing.',
    successCapabilities: [],
  },
] as const;

/**
 * The prose skeleton, with no tools. Used as a first paint before the real list
 * arrives, so a screen never invents tools it cannot vouch for.
 */
export function getProviderCatalog(): readonly Provider[] {
  return providerCatalog.map((provider) => ({ ...structuredClone(provider), tools: [] }));
}

export function isConnectableProvider(providerId: ProviderId): providerId is ConnectableProviderId {
  return providerId !== 'notion';
}

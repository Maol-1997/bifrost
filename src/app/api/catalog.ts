import type { ConnectableProviderId, Provider } from './types';

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
    toolDiscoveryFailed: false,
    permissions: ['Use the GitHub tools your Bifrost administrator has approved'],
    neverPermission: 'Tools your administrator has not approved are never exposed to your agents.',
    successCapabilities: ['Use the GitHub tools available to your account'],
  },
  {
    id: 'linear', name: 'Linear', monogram: 'L', description: 'Where projects and tasks are tracked.', status: 'needs-reconnect', isHidden: false,
    toolDiscoveryFailed: false,
    permissions: ['Use the Linear tools your Bifrost administrator has approved'],
    neverPermission: 'Tools your administrator has not approved are never exposed to your agents.',
    successCapabilities: ['Use the Linear tools available to your account'],
  },
  {
    id: 'sentry', name: 'Sentry', monogram: 'Se', description: 'Where application errors and traces are investigated.', status: 'not-connected', isHidden: false,
    toolDiscoveryFailed: false,
    permissions: ['Use the Sentry tools your Bifrost administrator has approved'],
    neverPermission: 'Tools your administrator has not approved are never exposed to your agents.',
    successCapabilities: ['Use the Sentry tools available to your account'],
  },
  {
    id: 'slack', name: 'Slack', monogram: 'S', description: 'Where the team talks.', status: 'not-connected', isHidden: false,
    toolDiscoveryFailed: false,
    permissions: ['Use the Slack tools your Bifrost administrator has approved'],
    neverPermission: 'Tools your administrator has not approved are never exposed to your agents.',
    successCapabilities: ['Use the Slack tools available to your account'],
  },
  {
    id: 'notion', name: 'Notion', monogram: 'N', description: 'Where docs and notes live.', status: 'unavailable', isHidden: false,
    toolDiscoveryFailed: false,
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

export function isConnectableProvider(providerId: string): providerId is ConnectableProviderId {
  return providerId === 'github' || providerId === 'linear' || providerId === 'sentry' || providerId === 'slack';
}

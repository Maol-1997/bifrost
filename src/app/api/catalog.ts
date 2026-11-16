import type { ProviderId, Provider } from './types';

/**
 * What each app is and what connecting it lets agents do. Tools come from the
 * server, so every claim here must hold for the tools it actually registers.
 * `neverPermission` speaks about tools, not about what the provider allows:
 * OAuth scopes are broader than the tools, and the tools are what Bifrost enforces.
 */
export const providerCatalog: readonly Omit<Provider, 'tools'>[] = [
  {
    id: 'github',
    name: 'GitHub',
    monogram: 'G',
    description: "Where your team's code and code reviews live.",
    status: 'connected',
    isHidden: false,
    toolDiscoveryFailed: false,
    permissions: ['Use the GitHub tools your Bifrost administrator has approved'],
    neverPermission: 'Tools your administrator has not approved are never exposed to your agents.',
    successCapabilities: ['Use the GitHub tools available to your account'],
  },
  {
    id: 'linear',
    name: 'Linear',
    monogram: 'L',
    description: 'Where projects and tasks are tracked.',
    status: 'needs-reconnect',
    isHidden: false,
    toolDiscoveryFailed: false,
    permissions: ['Use the Linear tools your Bifrost administrator has approved'],
    neverPermission: 'Tools your administrator has not approved are never exposed to your agents.',
    successCapabilities: ['Use the Linear tools available to your account'],
  },
  {
    id: 'sentry',
    name: 'Sentry',
    monogram: 'Se',
    description: 'Where application errors and traces are investigated.',
    status: 'not-connected',
    isHidden: false,
    toolDiscoveryFailed: false,
    permissions: ['Use the Sentry tools your Bifrost administrator has approved'],
    neverPermission: 'Tools your administrator has not approved are never exposed to your agents.',
    successCapabilities: ['Use the Sentry tools available to your account'],
  },
  {
    id: 'slack',
    name: 'Slack',
    monogram: 'S',
    description: 'Where the team talks.',
    status: 'not-connected',
    isHidden: false,
    toolDiscoveryFailed: false,
    permissions: ['Use the Slack tools your Bifrost administrator has approved'],
    neverPermission: 'Tools your administrator has not approved are never exposed to your agents.',
    successCapabilities: ['Use the Slack tools available to your account'],
  },
  {
    id: 'notion',
    name: 'Notion',
    monogram: 'N',
    description: 'Where docs and notes live.',
    status: 'not-connected',
    isHidden: false,
    toolDiscoveryFailed: false,
    permissions: ['Use the Notion tools your Bifrost administrator has approved'],
    neverPermission: 'Tools your administrator has not approved are never exposed to your agents.',
    successCapabilities: ['Use the Notion tools available to your account'],
  },
  {
    id: 'granola',
    name: 'Granola',
    monogram: 'Gr',
    description: 'Where meeting notes and transcripts live.',
    status: 'not-connected',
    isHidden: false,
    toolDiscoveryFailed: false,
    permissions: ['Use the Granola tools your Bifrost administrator has approved'],
    neverPermission: 'Tools your administrator has not approved are never exposed to your agents.',
    successCapabilities: ['Use the Granola tools available to your account'],
  },
] as const;

/**
 * The prose skeleton, with no tools. Used as a first paint before the real list
 * arrives, so a screen never invents tools it cannot vouch for.
 */
export function getProviderCatalog(): readonly Provider[] {
  return providerCatalog.map((provider) => ({ ...structuredClone(provider), tools: [] }));
}

export function isConnectableProvider(providerId: string): providerId is ProviderId {
  return (
    providerId === 'github' ||
    providerId === 'linear' ||
    providerId === 'sentry' ||
    providerId === 'slack' ||
    providerId === 'notion' ||
    providerId === 'granola'
  );
}

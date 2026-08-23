import type { ProviderDefinition } from './types.js';

export const sentryProvider: ProviderDefinition = {
  id: 'sentry', prefix: 'sentry_', displayName: 'Sentry',
  mcpUrl: 'https://mcp.sentry.dev/mcp',
  oauth: {
    kind: 'dynamic',
    issuer: 'https://mcp.sentry.dev',
    discoveryAlgorithm: 'oauth2',
    authorizationUrl: 'https://mcp.sentry.dev/oauth/authorize',
    tokenUrl: 'https://mcp.sentry.dev/oauth/token',
    resource: 'https://mcp.sentry.dev/mcp',
    scopes: ['org:read', 'project:write', 'team:write', 'event:write'],
  },
};

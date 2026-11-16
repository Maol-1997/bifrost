import type { ProviderDefinition } from './types.js';

export const granolaProvider: ProviderDefinition = {
  id: 'granola',
  prefix: 'granola_',
  displayName: 'Granola',
  mcpUrl: 'https://mcp.granola.ai/mcp',
  oauth: {
    kind: 'dynamic',
    issuer: 'https://mcp-auth.granola.ai',
    discoveryAlgorithm: 'oauth2',
    authorizationUrl: 'https://mcp-auth.granola.ai/oauth2/authorize',
    tokenUrl: 'https://mcp-auth.granola.ai/oauth2/token',
    resource: 'https://mcp.granola.ai/mcp',
    scopes: ['mcp'],
  },
};

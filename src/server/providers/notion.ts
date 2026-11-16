import type { ProviderDefinition } from './types.js';

export const notionProvider: ProviderDefinition = {
  id: 'notion',
  prefix: 'notion_',
  displayName: 'Notion',
  mcpUrl: 'https://mcp.notion.com/mcp',
  oauth: {
    kind: 'dynamic',
    issuer: 'https://mcp.notion.com',
    discoveryAlgorithm: 'oauth2',
    authorizationUrl: 'https://mcp.notion.com/authorize',
    tokenUrl: 'https://mcp.notion.com/token',
    resource: 'https://mcp.notion.com/mcp',
    scopes: ['default'],
  },
};

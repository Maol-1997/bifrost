import { z } from 'zod';
import { fetchJson } from './http.js';
import type { ProviderDefinition } from './types.js';

const viewerSchema = z.object({ login: z.string().min(1) });

export const githubProvider: ProviderDefinition = {
  id: 'github', prefix: 'github_', displayName: 'GitHub',
  mcpUrl: 'https://api.githubcopilot.com/mcp/',
  oauth: {
    kind: 'static',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['read:user', 'user:email', 'repo'],
  },
  readAccountLabel: async (accessToken, signal) => {
    const viewer = await fetchJson('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json', Authorization: `Bearer ${accessToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, signal);
    return `@${viewerSchema.parse(viewer).login}`;
  },
};

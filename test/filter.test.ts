import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { ProviderDefinition, ProviderMount } from '../src/server/providers/types.js';
import { visibleTools } from '../src/server/tools/filter.js';

const readAccountLabel = async (): Promise<string> => '@tester';
const providers: readonly ProviderDefinition[] = [
  { id: 'github', prefix: 'github_', displayName: 'GitHub', authorizationUrl: '', tokenUrl: '', scopes: [], readAccountLabel, tools: [{ name: 'github_read', title: 'Read', description: 'Read', mutability: 'read', inputSchema: z.object({}), execute: async () => ({}) }] },
  { id: 'slack', prefix: 'slack_', displayName: 'Slack', authorizationUrl: '', tokenUrl: '', scopes: [], readAccountLabel, tools: [{ name: 'slack_read', title: 'Read', description: 'Read', mutability: 'read', inputSchema: z.object({}), execute: async () => ({}) }] },
];
const mounted: readonly ProviderMount[] = [
  { providerId: 'github', isMounted: true }, { providerId: 'slack', isMounted: true },
];
const connectedToBoth = new Set(['github', 'slack'] as const);

describe('tool visibility filtering', () => {
  it('shows Slack to connected user A but not unconnected user B', () => {
    const userATools = visibleTools(providers, mounted, { connectedProviders: new Set(['github', 'slack']), hiddenProviders: new Set(), disabledTools: new Set() });
    const userBTools = visibleTools(providers, mounted, { connectedProviders: new Set(['github']), hiddenProviders: new Set(), disabledTools: new Set() });

    expect(userATools.map((tool) => tool.name)).toEqual(['github_read', 'slack_read']);
    expect(userBTools.map((tool) => tool.name)).toEqual(['github_read']);
  });

  it('fails closed for a provider the deployment never mounted', () => {
    const unmountedSlack = mounted.map((mount) => mount.providerId === 'slack' ? { ...mount, isMounted: false } : mount);

    expect(visibleTools(providers, unmountedSlack, { connectedProviders: connectedToBoth, hiddenProviders: new Set(), disabledTools: new Set() }).map((tool) => tool.name)).toEqual(['github_read']);
  });

  it('fails closed for a provider the user hid in Integrations', () => {
    expect(visibleTools(providers, mounted, { connectedProviders: connectedToBoth, hiddenProviders: new Set(['slack']), disabledTools: new Set() }).map((tool) => tool.name)).toEqual(['github_read']);
  });

  it('drops a tool the user switched off, and only that one', () => {
    const tools = visibleTools(providers, mounted, {
      connectedProviders: connectedToBoth, hiddenProviders: new Set(), disabledTools: new Set(['github_read']),
    });

    // Not registered means not callable either: the MCP server is rebuilt per
    // request, so a tool missing here cannot be reached by name.
    expect(tools.map((tool) => tool.name)).toEqual(['slack_read']);
  });
});

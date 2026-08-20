import { describe, expect, it } from 'vitest';
import type { ProviderMount } from '../src/server/providers/types.js';
import type { DiscoveredTool } from '../src/server/tools/catalog.js';
import { visibleTools } from '../src/server/tools/filter.js';

const tools: readonly DiscoveredTool[] = [
  { providerId: 'github', upstreamName: 'read', name: 'github_read', title: 'Read', description: 'Read', mutability: 'read', fingerprint: 'a'.repeat(64), contract: { providerId: 'github', tool: { name: 'read' } }, inputSchema: { type: 'object' } },
  { providerId: 'slack', upstreamName: 'read', name: 'slack_read', title: 'Read', description: 'Read', mutability: 'read', fingerprint: 'b'.repeat(64), contract: { providerId: 'slack', tool: { name: 'read' } }, inputSchema: { type: 'object' } },
];
const mounted: readonly ProviderMount[] = [
  { providerId: 'github', isMounted: true }, { providerId: 'slack', isMounted: true },
];
const connectedToBoth = new Set(['github', 'slack'] as const);
const enabledTools = new Set(tools.map((tool) => tool.name));

describe('tool visibility filtering', () => {
  it('shows Slack to connected user A but not unconnected user B', () => {
    const userATools = visibleTools(tools, mounted, { connectedProviders: connectedToBoth, hiddenProviders: new Set(), enabledTools });
    const userBTools = visibleTools(tools, mounted, { connectedProviders: new Set(['github']), hiddenProviders: new Set(), enabledTools });

    expect(userATools.map((tool) => tool.name)).toEqual(['github_read', 'slack_read']);
    expect(userBTools.map((tool) => tool.name)).toEqual(['github_read']);
  });

  it('fails closed for a provider the deployment never mounted', () => {
    const unmountedSlack = mounted.map((mount) => mount.providerId === 'slack' ? { ...mount, isMounted: false } : mount);

    expect(visibleTools(tools, unmountedSlack, { connectedProviders: connectedToBoth, hiddenProviders: new Set(), enabledTools }).map((tool) => tool.name)).toEqual(['github_read']);
  });

  it('fails closed for a provider the user hid in Integrations', () => {
    expect(visibleTools(tools, mounted, { connectedProviders: connectedToBoth, hiddenProviders: new Set(['slack']), enabledTools }).map((tool) => tool.name)).toEqual(['github_read']);
  });

  it('drops a tool that is not enabled, and only that one', () => {
    const visible = visibleTools(tools, mounted, {
      connectedProviders: connectedToBoth, hiddenProviders: new Set(), enabledTools: new Set(['slack_read']),
    });

    expect(visible.map((tool) => tool.name)).toEqual(['slack_read']);
  });
});

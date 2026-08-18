import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { ProviderDefinition, ToolDefinition, ToolMutability } from '../src/providers/types.js';
import { disabledToolNames, isToolPreferred, isWithinDeploymentCeiling, knownToolNames, toolAvailability } from '../src/tools/preferences.js';

const tool = (name: string, mutability: ToolMutability): ToolDefinition => ({
  name, title: name, description: name, mutability, inputSchema: z.object({}), execute: async () => ({}),
});

const readTool = tool('github_get_pull_request', 'read');
const writeTool = tool('github_create_issue_comment', 'write');
const noCeiling = new Set<string>();

describe('the user preference, and what no preference means', () => {
  it('starts a read tool on and a write tool off', () => {
    const none = new Map<string, boolean>();
    expect(isToolPreferred(readTool, none)).toBe(true);
    expect(isToolPreferred(writeTool, none)).toBe(false);
  });

  it('lets a stored choice override either default in both directions', () => {
    expect(isToolPreferred(readTool, new Map([[readTool.name, false]]))).toBe(false);
    expect(isToolPreferred(writeTool, new Map([[writeTool.name, true]]))).toBe(true);
  });

  it('reads a stored false as a real choice, not as a missing one', () => {
    // The bug this guards: `preferences.get(name) || default` would turn a
    // deliberate "off" on a read tool back into "on".
    expect(isToolPreferred(readTool, new Map([[readTool.name, false]]))).toBe(false);
  });

  it('ignores preferences stored against other tools', () => {
    expect(isToolPreferred(readTool, new Map([['slack_post_message', false]]))).toBe(true);
  });
});

describe('the deployment ceiling', () => {
  it('never constrains a read tool, whatever the allowlist says', () => {
    expect(isWithinDeploymentCeiling(readTool, noCeiling)).toBe(true);
    expect(isWithinDeploymentCeiling(readTool, new Set(['slack_post_message']))).toBe(true);
  });

  it('treats an empty allowlist as no ceiling rather than as deny-all', () => {
    expect(isWithinDeploymentCeiling(writeTool, noCeiling)).toBe(true);
  });

  it('permits only the named write tools once anything is named', () => {
    const ceiling = new Set([writeTool.name]);
    expect(isWithinDeploymentCeiling(writeTool, ceiling)).toBe(true);
    expect(isWithinDeploymentCeiling(tool('slack_post_message', 'write'), ceiling)).toBe(false);
  });
});

describe('the two authorities together', () => {
  it('reports a blocked tool as off, and says the server is why', () => {
    const availability = toolAvailability(writeTool, new Map([[writeTool.name, true]]), new Set(['linear_create_issue']));
    // The user asked for it and still does not get it: the ceiling wins, and the
    // UI needs to explain that rather than show a switch that does nothing.
    expect(availability).toEqual({ isEnabled: false, isBlockedByServer: true });
  });

  it('reports a user-disabled tool as off without blaming the server', () => {
    expect(toolAvailability(readTool, new Map([[readTool.name, false]]), noCeiling))
      .toEqual({ isEnabled: false, isBlockedByServer: false });
  });

  it('turns a write tool on only once the user says so', () => {
    expect(toolAvailability(writeTool, new Map(), noCeiling)).toEqual({ isEnabled: false, isBlockedByServer: false });
    expect(toolAvailability(writeTool, new Map([[writeTool.name, true]]), noCeiling)).toEqual({ isEnabled: true, isBlockedByServer: false });
  });
});

describe('collecting names across the registry', () => {
  const providers: readonly ProviderDefinition[] = [
    { id: 'github', prefix: 'github_', displayName: 'GitHub', authorizationUrl: '', tokenUrl: '', scopes: [], readAccountLabel: async () => '@t', tools: [readTool, writeTool] },
  ];

  it('disables the write tool by default and leaves the read tool alone', () => {
    expect([...disabledToolNames(providers, new Map(), noCeiling)]).toEqual([writeTool.name]);
  });

  it('disables nothing once the write tool is turned on', () => {
    expect([...disabledToolNames(providers, new Map([[writeTool.name, true]]), noCeiling)]).toEqual([]);
  });

  it('disables a tool the ceiling forbids even when the user enabled it', () => {
    expect([...disabledToolNames(providers, new Map([[writeTool.name, true]]), new Set(['linear_create_issue']))]).toEqual([writeTool.name]);
  });

  it('lists every tool the server serves, so a preference cannot name a fake one', () => {
    expect(knownToolNames(providers)).toEqual(new Set([readTool.name, writeTool.name]));
  });
});

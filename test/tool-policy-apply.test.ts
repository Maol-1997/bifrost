import type { Tool } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDefinition } from '../src/server/providers/types.js';
import { normalizeUpstreamTool, reconcileToolPreferences } from '../src/server/tools/catalog.js';
import type { ToolDiscoveryService } from '../src/server/tools/discovery.js';
import { applyToolPolicies, type ToolPolicyDependencies } from '../src/server/tools/policy.js';

const provider: ProviderDefinition = {
  id: 'github',
  prefix: 'github_',
  displayName: 'GitHub',
  mcpUrl: 'https://example.test/mcp',
  oauth: { kind: 'static', authorizationUrl: '', tokenUrl: '', scopes: [] },
};
const readDefinition: Tool = {
  name: 'get_issue',
  title: 'Get issue',
  description: 'Read an issue.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};
const writeDefinition: Tool = { ...readDefinition, name: 'close_issue', annotations: {} };
const readTool = normalizeUpstreamTool(provider, readDefinition);
const writeTool = normalizeUpstreamTool(provider, writeDefinition);
const adminUserId = '11111111-1111-4111-8111-111111111111';

type Harness = {
  dependencies: ToolPolicyDependencies;
  setToolPolicies: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  discoverProviderFresh: ReturnType<typeof vi.fn>;
  discoverProvider: ReturnType<typeof vi.fn>;
};

function harness(): Harness {
  const setToolPolicies = vi.fn(async () => undefined);
  const broadcast = vi.fn(async () => undefined);
  const discoverProviderFresh = vi.fn(async () => ({
    tools: [readTool, writeTool],
    cache: { state: 'fresh' as const, freshForMs: 3_600_000, nextCheckInMs: 3_600_000 },
  }));
  const discoverProvider = vi.fn();
  return {
    setToolPolicies,
    broadcast,
    discoverProviderFresh,
    discoverProvider,
    dependencies: {
      database: { setToolPolicies },
      events: { broadcast },
      toolDiscovery: { discoverProviderFresh, discoverProvider } as unknown as ToolDiscoveryService,
    },
  };
}

function apply(
  harnessed: Harness,
  changes: readonly {
    toolName: string;
    fingerprint: string;
    state: 'blocked' | 'allowed_default_off' | 'allowed_default_on';
  }[],
) {
  return applyToolPolicies({
    userId: adminUserId,
    providerId: 'github',
    changes,
    dependencies: harnessed.dependencies,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('applying deployment tool policies', () => {
  it('approves against a fresh listing rather than the cached one', async () => {
    const harnessed = harness();

    await apply(harnessed, [
      { toolName: readTool.name, fingerprint: readTool.fingerprint, state: 'allowed_default_on' },
    ]);

    expect(harnessed.discoverProviderFresh).toHaveBeenCalledExactlyOnceWith({
      userId: adminUserId,
      providerId: 'github',
    });
    expect(harnessed.discoverProvider).not.toHaveBeenCalled();
  });

  it('writes the contract that produced the approved fingerprint', async () => {
    const harnessed = harness();

    await apply(harnessed, [
      { toolName: readTool.name, fingerprint: readTool.fingerprint, state: 'allowed_default_on' },
    ]);

    expect(harnessed.setToolPolicies).toHaveBeenCalledExactlyOnceWith([
      {
        providerId: 'github',
        toolName: readTool.name,
        fingerprint: readTool.fingerprint,
        contract: readTool.contract,
        state: 'allowed_default_on',
        updatedByUserId: adminUserId,
      },
    ]);
  });

  it('tells every open browser that the deployment tool list moved', async () => {
    const harnessed = harness();

    await apply(harnessed, [{ toolName: readTool.name, fingerprint: readTool.fingerprint, state: 'blocked' }]);

    expect(harnessed.broadcast.mock.calls.flat()).toEqual(['providers-changed', 'admin-tools-changed']);
  });

  it('reports the states it applied', async () => {
    const harnessed = harness();

    const result = await apply(harnessed, [
      { toolName: readTool.name, fingerprint: readTool.fingerprint, state: 'allowed_default_on' },
      { toolName: writeTool.name, fingerprint: writeTool.fingerprint, state: 'blocked' },
    ]);

    expect(result).toMatchObject({
      status: 'applied',
      providerId: 'github',
      counts: { blocked: 1, allowedDefaultOff: 0, allowedDefaultOn: 1 },
    });
  });

  it('rejects the whole batch when one selected definition changed', async () => {
    const harnessed = harness();

    const result = await apply(harnessed, [
      { toolName: readTool.name, fingerprint: readTool.fingerprint, state: 'allowed_default_on' },
      { toolName: writeTool.name, fingerprint: '0'.repeat(64), state: 'allowed_default_on' },
    ]);

    expect(result).toEqual({ status: 'stale' });
    expect(harnessed.setToolPolicies).not.toHaveBeenCalled();
    expect(harnessed.broadcast).not.toHaveBeenCalled();
  });

  it('rejects a batch naming a tool the provider does not expose', async () => {
    const harnessed = harness();

    const result = await apply(harnessed, [
      { toolName: 'github_unknown', fingerprint: readTool.fingerprint, state: 'blocked' },
    ]);

    expect(result).toEqual({ status: 'stale' });
    expect(harnessed.setToolPolicies).not.toHaveBeenCalled();
  });

  it('rejects a batch that names the same tool twice', async () => {
    const harnessed = harness();
    const change = { toolName: readTool.name, fingerprint: readTool.fingerprint, state: 'blocked' as const };

    const result = await apply(harnessed, [change, change]);

    expect(result).toEqual({ status: 'stale' });
    expect(harnessed.setToolPolicies).not.toHaveBeenCalled();
  });
});

describe('reconciling user overrides with a policy change', () => {
  it('clears every override when the approved contract changed', () => {
    expect(
      reconcileToolPreferences({ fingerprint: readTool.fingerprint, state: 'allowed_default_on' }, '0'.repeat(64)),
    ).toEqual({ kind: 'clear-all' });
  });

  it('clears every override for a tool with no previous policy', () => {
    expect(
      reconcileToolPreferences({ fingerprint: readTool.fingerprint, state: 'allowed_default_off' }, undefined),
    ).toEqual({ kind: 'clear-all' });
  });

  it('clears every override when the tool is blocked', () => {
    expect(
      reconcileToolPreferences({ fingerprint: readTool.fingerprint, state: 'blocked' }, readTool.fingerprint),
    ).toEqual({ kind: 'clear-all' });
  });

  it('clears the overrides that only restate an on-by-default policy', () => {
    expect(
      reconcileToolPreferences(
        { fingerprint: readTool.fingerprint, state: 'allowed_default_on' },
        readTool.fingerprint,
      ),
    ).toEqual({ kind: 'clear-redundant', isEnabled: true });
  });

  it('clears the overrides that only restate an off-by-default policy', () => {
    expect(
      reconcileToolPreferences(
        { fingerprint: readTool.fingerprint, state: 'allowed_default_off' },
        readTool.fingerprint,
      ),
    ).toEqual({ kind: 'clear-redundant', isEnabled: false });
  });
});

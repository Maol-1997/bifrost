import type { Tool } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import type { ToolPolicyOrigin, ToolRule } from '../src/server/database/tool-policies.js';
import type { ProviderDefinition } from '../src/server/providers/types.js';
import {
  pendingAutoPolicyTools,
  reconcileAutoPolicies,
  saveToolRule,
  type AutoPolicyDependencies,
  type ToolRuleDependencies,
} from '../src/server/tools/auto-policy.js';
import { normalizeUpstreamTool } from '../src/server/tools/catalog.js';

const provider: ProviderDefinition = {
  id: 'github',
  prefix: 'github_',
  displayName: 'GitHub',
  mcpUrl: 'https://example.test/mcp',
  oauth: { kind: 'static', authorizationUrl: '', tokenUrl: '', scopes: [] },
};
const definition: Tool = {
  name: 'merge_pull_request',
  description: 'Merge a pull request.',
  inputSchema: { type: 'object' },
};
const mergeTool = normalizeUpstreamTool(provider, definition);
const issuesTool = normalizeUpstreamTool(provider, { ...definition, name: 'list_issues', description: 'List issues.' });
const rule: ToolRule = {
  providerId: 'github',
  instructions: 'Only pull request tools.',
  revision: 2,
  updatedAt: new Date(0),
};

function origin(overrides: Partial<ToolPolicyOrigin> & { fingerprint: string }): ToolPolicyOrigin {
  return { source: 'auto', autoProbability: 0.9, ruleRevision: rule.revision, ...overrides };
}

function harness(
  options: {
    origins?: ReadonlyMap<string, ToolPolicyOrigin>;
    rule?: ToolRule | undefined;
    apiKey?: string | undefined;
    backoff?: boolean;
    classify?: AutoPolicyDependencies['classify'];
  } = {},
) {
  const setAutoToolPolicies = vi.fn(async (requests: readonly { toolName: string }[]) =>
    requests.map((request) => request.toolName),
  );
  const broadcast = vi.fn(async () => undefined);
  const setEphemeral = vi.fn(async () => undefined);
  const classify =
    options.classify ??
    vi.fn(
      async () =>
        new Map([
          [mergeTool.name, 0.91],
          [issuesTool.name, 0.5],
        ]),
    );
  const dependencies: AutoPolicyDependencies = {
    config: {
      OPENROUTER_API_KEY: 'apiKey' in options ? options.apiKey : 'key',
      OPENROUTER_BASE_URL: 'https://openrouter.test/api',
      JEV_MODEL: 'typesafe/jev-1.13',
    },
    database: {
      toolRule: vi.fn(async () => ('rule' in options ? options.rule : rule)),
      toolPolicyOrigins: vi.fn(async () => options.origins ?? new Map()),
      setAutoToolPolicies,
    },
    coordinator: {
      withLock: async (_key, operation) => operation(),
      setEphemeral,
      peekEphemeral: vi.fn(async () => (options.backoff ? '1' : undefined)),
    },
    events: { broadcast },
    classify,
  };
  return { dependencies, setAutoToolPolicies, broadcast, setEphemeral, classify };
}

function reconcile(dependencies: AutoPolicyDependencies) {
  return reconcileAutoPolicies({ providerId: 'github', tools: [mergeTool, issuesTool], dependencies });
}

describe('which tools a rule still has to decide', () => {
  it('includes tools without a policy', () => {
    expect(pendingAutoPolicyTools([mergeTool], new Map(), rule)).toEqual([mergeTool]);
  });

  it('includes a definition that changed, even after a manual decision', () => {
    const origins = new Map([[mergeTool.name, origin({ fingerprint: 'old', source: 'admin' })]]);

    expect(pendingAutoPolicyTools([mergeTool], origins, rule)).toEqual([mergeTool]);
  });

  it('includes its own decisions made under an older rule revision', () => {
    const origins = new Map([[mergeTool.name, origin({ fingerprint: mergeTool.fingerprint, ruleRevision: 1 })]]);

    expect(pendingAutoPolicyTools([mergeTool], origins, rule)).toEqual([mergeTool]);
  });

  it('leaves a manual decision on the current definition alone', () => {
    const origins = new Map([
      [mergeTool.name, origin({ fingerprint: mergeTool.fingerprint, source: 'admin', ruleRevision: null })],
    ]);

    expect(pendingAutoPolicyTools([mergeTool], origins, rule)).toEqual([]);
  });

  it('leaves current decisions under the current revision alone', () => {
    const origins = new Map([[mergeTool.name, origin({ fingerprint: mergeTool.fingerprint })]]);

    expect(pendingAutoPolicyTools([mergeTool], origins, rule)).toEqual([]);
  });
});

describe('applying a provider rule', () => {
  it('writes each pending tool with its classified default', async () => {
    const harnessed = harness();

    const outcome = await reconcile(harnessed.dependencies);

    expect(outcome).toEqual({ status: 'applied', classified: 2, written: 2 });
    expect(harnessed.setAutoToolPolicies).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        toolName: mergeTool.name,
        state: 'allowed_default_on',
        autoProbability: 0.91,
        ruleRevision: 2,
        fingerprint: mergeTool.fingerprint,
      }),
      expect.objectContaining({
        toolName: issuesTool.name,
        state: 'allowed_default_off',
        autoProbability: 0.5,
        ruleRevision: 2,
      }),
    ]);
    expect(harnessed.broadcast).toHaveBeenCalledWith('providers-changed');
  });

  it('does nothing without an API key', async () => {
    const harnessed = harness({ apiKey: undefined });

    expect(await reconcile(harnessed.dependencies)).toEqual({ status: 'not-configured' });
    expect(harnessed.classify).not.toHaveBeenCalled();
  });

  it('does nothing without a rule', async () => {
    const harnessed = harness({ rule: undefined });

    expect(await reconcile(harnessed.dependencies)).toEqual({ status: 'no-rule' });
    expect(harnessed.classify).not.toHaveBeenCalled();
  });

  it('skips the classifier when nothing is pending', async () => {
    const origins = new Map([
      [mergeTool.name, origin({ fingerprint: mergeTool.fingerprint })],
      [issuesTool.name, origin({ fingerprint: issuesTool.fingerprint, source: 'admin' })],
    ]);
    const harnessed = harness({ origins });

    expect(await reconcile(harnessed.dependencies)).toEqual({ status: 'applied', classified: 0, written: 0 });
    expect(harnessed.classify).not.toHaveBeenCalled();
  });

  it('writes nothing and backs off when the classifier fails', async () => {
    const harnessed = harness({
      classify: vi.fn(async () => {
        throw new Error('down');
      }),
    });

    await expect(reconcile(harnessed.dependencies)).rejects.toThrow('down');
    expect(harnessed.setAutoToolPolicies).not.toHaveBeenCalled();
    expect(harnessed.setEphemeral).toHaveBeenCalledWith('auto-policy-backoff:github:2', '1', 300);
  });

  it('does not call the classifier while backing off', async () => {
    const harnessed = harness({ backoff: true });

    expect(await reconcile(harnessed.dependencies)).toEqual({ status: 'backing-off' });
    expect(harnessed.classify).not.toHaveBeenCalled();
  });

  it('reports busy when another worker holds the lock', async () => {
    const harnessed = harness();
    harnessed.dependencies.coordinator.withLock = async () => {
      throw new Error('locked');
    };

    expect(await reconcile(harnessed.dependencies)).toEqual({ status: 'busy' });
    expect(harnessed.classify).not.toHaveBeenCalled();
  });

  it('does not broadcast when every write lost to a manual decision', async () => {
    const harnessed = harness();
    harnessed.setAutoToolPolicies.mockResolvedValueOnce([]);

    expect(await reconcile(harnessed.dependencies)).toEqual({ status: 'applied', classified: 2, written: 0 });
    expect(harnessed.broadcast).not.toHaveBeenCalled();
  });
});

describe('saving a provider rule', () => {
  function ruleHarness(options: { apiKey?: string | undefined; connected?: boolean; discoveryFails?: boolean } = {}) {
    const base = harness({ apiKey: 'apiKey' in options ? options.apiKey : 'key' });
    const setToolRule = vi.fn(async () => ({ ...rule, revision: 3 }));
    const discoverProviderFresh = vi.fn(async () => {
      if (options.discoveryFails) throw new Error('upstream down');
      return { tools: [mergeTool, issuesTool], cache: { state: 'fresh' as const, freshForMs: 0, nextCheckInMs: 0 } };
    });
    const dependencies: ToolRuleDependencies = {
      ...base.dependencies,
      database: {
        ...base.dependencies.database,
        setToolRule,
        clearToolRule: vi.fn(async () => undefined),
        connectedProviders: vi.fn(async () => new Set(options.connected === false ? [] : ['github' as const])),
      },
      toolDiscovery: { discoverProviderFresh },
    };
    return { ...base, dependencies, setToolRule, discoverProviderFresh };
  }

  function save(dependencies: ToolRuleDependencies) {
    return saveToolRule({
      userId: 'admin',
      providerId: 'github',
      instructions: 'Only pull request tools.',
      dependencies,
    });
  }

  it("saves and applies the rule to the administrator's fresh listing", async () => {
    const harnessed = ruleHarness();

    expect(await save(harnessed.dependencies)).toEqual({ status: 'saved', revision: 3, classification: 'applied' });
    expect(harnessed.setToolRule).toHaveBeenCalledWith({
      providerId: 'github',
      instructions: 'Only pull request tools.',
      updatedByUserId: 'admin',
    });
    expect(harnessed.discoverProviderFresh).toHaveBeenCalledOnce();
    expect(harnessed.setAutoToolPolicies).toHaveBeenCalledOnce();
  });

  it('refuses to save without an API key', async () => {
    const harnessed = ruleHarness({ apiKey: undefined });

    expect(await save(harnessed.dependencies)).toEqual({ status: 'not-configured' });
    expect(harnessed.setToolRule).not.toHaveBeenCalled();
  });

  it('saves without applying when the administrator is not connected', async () => {
    const harnessed = ruleHarness({ connected: false });

    expect(await save(harnessed.dependencies)).toEqual({
      status: 'saved',
      revision: 3,
      classification: 'not-connected',
    });
    expect(harnessed.discoverProviderFresh).not.toHaveBeenCalled();
  });

  it('keeps the saved rule when applying it fails', async () => {
    const harnessed = ruleHarness({ discoveryFails: true });

    expect(await save(harnessed.dependencies)).toEqual({ status: 'saved', revision: 3, classification: 'failed' });
    expect(harnessed.setAutoToolPolicies).not.toHaveBeenCalled();
  });
});

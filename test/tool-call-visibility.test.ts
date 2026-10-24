import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/server/config.js';
import type { Coordinator } from '../src/server/coordination.js';
import type { Database } from '../src/server/database/index.js';
import type { OAuthService } from '../src/server/oauth.js';
import { PROVIDER_REGISTRY } from '../src/server/providers/registry.js';
import type { ProviderId, ProviderMount } from '../src/server/providers/types.js';
import type { UpstreamClientPool } from '../src/server/providers/upstream-pool.js';
import { normalizeUpstreamTool, type ToolPolicyState } from '../src/server/tools/catalog.js';
import { createInMemoryToolCacheStore } from '../src/server/tools/cache-store.js';
import { ToolDiscoveryService } from '../src/server/tools/discovery.js';
import { loadVisibleUserTool, loadVisibleUserTools, type UserToolDependencies } from '../src/server/tools/user-toolset.js';

vi.mock('../src/server/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  errorSummary: (error: unknown) => ({ error }),
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PROVIDERS: readonly ProviderId[] = ['github', 'linear'];
const UPSTREAM_TOOLS = [
  { name: 'echo', description: 'Echo.', inputSchema: { type: 'object' as const }, annotations: { readOnlyHint: true } },
  { name: 'write_note', description: 'Write.', inputSchema: { type: 'object' as const } },
];
const TARGET = 'github_echo';
const CALLED_NAMES = ['github_echo', 'github_write_note', 'linear_echo', 'github_missing', 'gitlab_echo'];

type PolicyAxis = 'none' | ToolPolicyState | 'stale fingerprint';
type State = {
  mounted: readonly ProviderId[];
  connected: readonly ProviderId[];
  hidden: readonly ProviderId[];
  policy: PolicyAxis;
  preference: boolean | undefined;
};

const fingerprints = new Map(PROVIDERS.flatMap((providerId) => {
  const provider = PROVIDER_REGISTRY.find((entry) => entry.id === providerId)!;
  return UPSTREAM_TOOLS.map((tool) => {
    const normalized = normalizeUpstreamTool(provider, tool);
    return [normalized.name, normalized.fingerprint] as const;
  });
}));

/** Real discovery over a stub upstream, recording which providers each resolution listed. */
function dependencies(state: State): { dependencies: UserToolDependencies; listed: ProviderId[] } {
  const listed: ProviderId[] = [];
  const upstreamClients: Pick<UpstreamClientPool, 'withClient'> = {
    withClient: async (request, operation) => {
      listed.push(request.provider.id);
      return operation({ listTools: async () => ({ tools: UPSTREAM_TOOLS }) } as never);
    },
  };
  const mounts: ProviderMount[] = PROVIDERS.map((providerId) => ({ providerId, isMounted: state.mounted.includes(providerId) }));
  const oauth = { getOrRefreshAccessToken: vi.fn(async () => 'token') } as unknown as OAuthService;
  const policies = new Map([...fingerprints].map(([name, fingerprint]) => [name, { toolName: name, fingerprint, state: 'allowed_default_on' as ToolPolicyState }]));
  if (state.policy === 'none') policies.delete(TARGET);
  else if (state.policy === 'stale fingerprint') policies.set(TARGET, { toolName: TARGET, fingerprint: '0'.repeat(64), state: 'allowed_default_on' });
  else policies.set(TARGET, { toolName: TARGET, fingerprint: fingerprints.get(TARGET)!, state: state.policy });
  const preferences = new Map(state.preference === undefined ? [] : [[TARGET, state.preference]]);
  return {
    listed,
    dependencies: {
      config: {} as Config,
      coordinator: {} as Coordinator,
      oauth,
      mounts,
      upstreamClients,
      database: {
        userVisibilityState: async () => ({
          connectedProviders: new Set(state.connected),
          hiddenProviders: new Set(state.hidden),
          toolPreferences: preferences,
        }),
        toolPolicyDecisions: async () => policies,
      } as unknown as Database,
      toolDiscovery: new ToolDiscoveryService({ oauth, mounts, store: createInMemoryToolCacheStore(), upstreamClients }),
    },
  };
}

function* states(): Generator<State> {
  for (const mounted of [PROVIDERS, ['linear'] as const]) {
    for (const connected of [PROVIDERS, ['github'] as const, ['linear'] as const, [] as const]) {
      for (const hidden of [[] as const, ['github'] as const]) {
        for (const policy of ['none', 'blocked', 'allowed_default_off', 'allowed_default_on', 'stale fingerprint'] as const) {
          for (const preference of [undefined, true, false]) yield { mounted, connected, hidden, policy, preference };
        }
      }
    }
  }
}

describe('resolving the one tool a tools/call names', () => {
  it('decides exactly as the full listing does on every visibility axis', async () => {
    const mismatches: string[] = [];
    let decisions = 0;
    let visibleDecisions = 0;
    for (const state of states()) {
      for (const name of CALLED_NAMES) {
        const full = await loadVisibleUserTools({ userId: USER_ID, dependencies: dependencies(state).dependencies });
        const single = await loadVisibleUserTool({ userId: USER_ID, toolName: name, dependencies: dependencies(state).dependencies });
        const expected = full.find((tool) => tool.name === name);
        decisions += 1;
        if (expected) visibleDecisions += 1;
        if (single?.fingerprint !== expected?.fingerprint || single?.name !== expected?.name) {
          mismatches.push(`${name} in ${JSON.stringify(state)}`);
        }
      }
    }

    // Both outcomes must actually occur, or the comparison proves nothing.
    expect({ mismatches, decisions, someVisible: visibleDecisions > 0, someHidden: visibleDecisions < decisions })
      .toEqual({ mismatches: [], decisions: 240 * CALLED_NAMES.length, someVisible: true, someHidden: true });
  });

  it('lists only the named tool’s provider, not every connected one', async () => {
    const state: State = { mounted: PROVIDERS, connected: PROVIDERS, hidden: [], policy: 'allowed_default_on', preference: undefined };
    const single = dependencies(state);
    const full = dependencies(state);

    await loadVisibleUserTool({ userId: USER_ID, toolName: 'github_echo', dependencies: single.dependencies });
    await loadVisibleUserTools({ userId: USER_ID, dependencies: full.dependencies });

    expect({ single: single.listed, full: [...full.listed].sort() }).toEqual({ single: ['github'], full: ['github', 'linear'] });
  });

  it('refuses a blocked, hidden, unconnected or changed tool', async () => {
    const visible: State = { mounted: PROVIDERS, connected: PROVIDERS, hidden: [], policy: 'allowed_default_on', preference: undefined };
    const cases: Record<string, State> = {
      visible,
      blocked: { ...visible, policy: 'blocked' },
      'switched off by the user': { ...visible, preference: false },
      hidden: { ...visible, hidden: ['github'] },
      'not connected': { ...visible, connected: ['linear'] },
      'not mounted': { ...visible, mounted: ['linear'] },
      'fingerprint changed': { ...visible, policy: 'stale fingerprint' },
    };

    const outcomes = Object.fromEntries(await Promise.all(Object.entries(cases).map(async ([label, state]): Promise<[string, string]> => {
      const tool = await loadVisibleUserTool({ userId: USER_ID, toolName: TARGET, dependencies: dependencies(state).dependencies });
      return [label, tool?.name ?? 'refused'];
    })));

    expect(outcomes).toEqual({
      visible: TARGET,
      blocked: 'refused',
      'switched off by the user': 'refused',
      hidden: 'refused',
      'not connected': 'refused',
      'not mounted': 'refused',
      'fingerprint changed': 'refused',
    });
  });
});

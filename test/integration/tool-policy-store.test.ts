import type { Tool } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AutoToolPolicyWrite } from '../../src/server/database/tool-policies.js';
import { PROVIDER_REGISTRY } from '../../src/server/providers/registry.js';
import { normalizeUpstreamTool, type ToolPolicyState } from '../../src/server/tools/catalog.js';
import { integrationEnvironment } from './environment.js';
import { createIntegrationHarness, type IntegrationHarness } from './harness.js';

let harness: IntegrationHarness;
let adminUserId: string;
let sequence = 0;

const github = PROVIDER_REGISTRY.find((provider) => provider.id === 'github')!;

beforeAll(async () => {
  harness = await createIntegrationHarness({ environment: integrationEnvironment() });
  adminUserId = await harness.createUser();
});

afterAll(async () => {
  await harness.close();
});

/** A fresh tool name per test, with two definitions that differ only in their description. */
function toolVersions() {
  sequence += 1;
  const definition: Tool = {
    name: `rule_guard_${sequence}`,
    description: 'Original contract.',
    inputSchema: { type: 'object' },
  };
  return {
    original: normalizeUpstreamTool(github, definition),
    changed: normalizeUpstreamTool(github, { ...definition, description: 'Changed contract.' }),
  };
}

type Version = ReturnType<typeof toolVersions>['original'];

async function adminDecides(tool: Version, state: ToolPolicyState): Promise<void> {
  await harness.database.setToolPolicies([
    {
      providerId: 'github',
      toolName: tool.name,
      fingerprint: tool.fingerprint,
      contract: tool.contract,
      state,
      updatedByUserId: adminUserId,
    },
  ]);
}

function ruleDecides(
  tool: Version,
  state: AutoToolPolicyWrite['state'],
  ruleRevision: number,
): Promise<readonly string[]> {
  return harness.database.setAutoToolPolicies([
    {
      providerId: 'github',
      toolName: tool.name,
      fingerprint: tool.fingerprint,
      contract: tool.contract,
      state,
      autoProbability: state === 'allowed_default_on' ? 0.95 : 0.05,
      ruleRevision,
    },
  ]);
}

async function storedPolicy(tool: Version) {
  const [origins, decisions] = await Promise.all([
    harness.database.toolPolicyOrigins('github'),
    harness.database.toolPolicyDecisions(),
  ]);
  return { origin: origins.get(tool.name), decision: decisions.get(tool.name) };
}

describe('automatic rule writes against real Postgres', () => {
  it('writes a policy for a tool nobody has decided', async () => {
    const { original } = toolVersions();

    await expect(ruleDecides(original, 'allowed_default_on', 1)).resolves.toEqual([original.name]);
    expect((await storedPolicy(original)).origin).toMatchObject({ source: 'auto', fingerprint: original.fingerprint });
  });

  it('never replaces an administrator block, even for a changed definition', async () => {
    const { original, changed } = toolVersions();
    await adminDecides(original, 'blocked');

    await expect(ruleDecides(changed, 'allowed_default_on', 1)).resolves.toEqual([]);
    await expect(ruleDecides(original, 'allowed_default_on', 1)).resolves.toEqual([]);

    const stored = await storedPolicy(original);
    expect(stored.origin).toMatchObject({ source: 'admin', fingerprint: original.fingerprint });
    expect(stored.decision?.state).toBe('blocked');
  });

  it('never replaces an administrator approval with a rule decision', async () => {
    const { original } = toolVersions();
    await adminDecides(original, 'allowed_default_off');

    await expect(ruleDecides(original, 'allowed_default_on', 5)).resolves.toEqual([]);
    expect((await storedPolicy(original)).decision?.state).toBe('allowed_default_off');
  });

  it('does not re-approve a changed definition it had decided before', async () => {
    const { original, changed } = toolVersions();
    await ruleDecides(original, 'allowed_default_off', 1);

    await expect(ruleDecides(changed, 'allowed_default_on', 2)).resolves.toEqual([]);

    const stored = await storedPolicy(original);
    expect(stored.origin?.fingerprint).toBe(original.fingerprint);
    // The live definition no longer matches the stored fingerprint, so it is blocked until reviewed.
    expect(stored.decision?.fingerprint).not.toBe(changed.fingerprint);
  });

  it('re-decides its own decision on the same definition under a newer rule', async () => {
    const { original } = toolVersions();
    await ruleDecides(original, 'allowed_default_off', 1);

    await expect(ruleDecides(original, 'allowed_default_on', 2)).resolves.toEqual([original.name]);
    await expect(ruleDecides(original, 'allowed_default_off', 1)).resolves.toEqual([]);
    expect((await storedPolicy(original)).decision?.state).toBe('allowed_default_on');
  });
});

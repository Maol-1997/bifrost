import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { assertPrefixInvariant } from '../src/providers/registry.js';
import type { ProviderDefinition } from '../src/providers/types.js';

const registry: readonly ProviderDefinition[] = [{
  id: 'github', prefix: 'github_', displayName: 'GitHub', authorizationUrl: '', tokenUrl: '', scopes: [],
  tools: [{ name: 'github_read', title: 'Read', description: 'Read', mutability: 'read', inputSchema: z.object({}), execute: async () => ({}) }],
}];

describe('provider prefix invariant', () => {
  it('accepts aligned registry, namespace, app, credential mapping, and tools', () => {
    expect(() => assertPrefixInvariant(registry, { github: 'github_' }, ['github'], { github_: 'github' })).not.toThrow();
  });

  it('fails startup when one character drifts', () => {
    expect(() => assertPrefixInvariant(registry, { github: 'github-' }, ['github'], { github_: 'github' }))
      .toThrow('github: namespace differs from registry prefix');
  });

  it('fails startup when a tool uses the wrong prefix', () => {
    const drifted = [{ ...registry[0]!, tools: [{ ...registry[0]!.tools[0]!, name: 'gitub_read' }] }];
    expect(() => assertPrefixInvariant(drifted, { github: 'github_' }, ['github'], { github_: 'github' }))
      .toThrow('tool gitub_read has wrong prefix');
  });
});

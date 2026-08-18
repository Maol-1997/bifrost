import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { assertPrefixInvariant, type PrefixInvariantInputs } from '../src/providers/registry.js';
import type { ProviderDefinition } from '../src/providers/types.js';

const registry: readonly ProviderDefinition[] = [{
  id: 'github', prefix: 'github_', displayName: 'GitHub', authorizationUrl: '', tokenUrl: '', scopes: [],
  readAccountLabel: async () => '@tester',
  tools: [{ name: 'github_read', title: 'Read', description: 'Read', mutability: 'read', inputSchema: z.object({}), execute: async () => ({}) }],
}];

/** The four fixtures in agreement, so each test can drift exactly one of them. */
const aligned: PrefixInvariantInputs = {
  registry,
  namespaces: { github: 'github_' },
  apps: ['github'],
  credentialMapping: { github_: 'github' },
};

function callInvariant(input: PrefixInvariantInputs = {}): void {
  assertPrefixInvariant(input);
}

describe('provider prefix invariant', () => {
  it('accepts aligned registry, namespace, app, credential mapping, and tools', () => {
    expect(() => { callInvariant(aligned); }).not.toThrow();
  });

  it('passes on the registry the server actually boots with', () => {
    expect(() => { callInvariant(); }).not.toThrow();
  });

  it('fails startup when one character drifts', () => {
    expect(() => { callInvariant({ ...aligned, namespaces: { github: 'github-' } }); })
      .toThrow('github: namespace differs from registry prefix');
  });

  it('fails startup when a provider is absent from the supported apps', () => {
    // The card never renders and /api/app-connections.json never offers it, so
    // the provider would mount tools nobody can connect an account for.
    expect(() => { callInvariant({ ...aligned, apps: [] }); })
      .toThrow('github: missing from supported apps');
  });

  it('fails startup when the credential mapping points the prefix elsewhere', () => {
    // This is the drift that fails silently at runtime: the tool loads someone
    // else's stored credential instead of erroring.
    expect(() => { callInvariant({ ...aligned, credentialMapping: { github_: 'linear' } }); })
      .toThrow('github: credential mapping differs from prefix');
  });

  it('fails startup when two providers claim the same prefix', () => {
    expect(() => { callInvariant({ ...aligned, registry: [...registry, ...registry] }); })
      .toThrow('provider prefixes are not unique');
  });

  it('fails startup when a tool uses the wrong prefix', () => {
    const drifted = [{ ...registry[0]!, tools: [{ ...registry[0]!.tools[0]!, name: 'gitub_read' }] }];
    expect(() => { callInvariant({ ...aligned, registry: drifted }); })
      .toThrow('tool gitub_read has wrong prefix');
  });
});

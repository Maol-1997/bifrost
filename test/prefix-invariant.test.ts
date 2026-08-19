import { describe, expect, it } from 'vitest';
import { assertPrefixInvariant, type PrefixInvariantInputs } from '../src/server/providers/registry.js';
import type { ProviderDefinition } from '../src/server/providers/types.js';

const registry: readonly ProviderDefinition[] = [{
  id: 'github', prefix: 'github_', displayName: 'GitHub', mcpUrl: 'https://example.test/mcp', authorizationUrl: '', tokenUrl: '', scopes: [],
  readAccountLabel: async () => '@tester',
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
  it('accepts aligned registry, namespace, app, and credential mapping', () => {
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
    expect(() => { callInvariant({ ...aligned, apps: [] }); })
      .toThrow('github: missing from supported apps');
  });

  it('fails startup when the credential mapping points the prefix elsewhere', () => {
    expect(() => { callInvariant({ ...aligned, credentialMapping: { github_: 'linear' } }); })
      .toThrow('github: credential mapping differs from prefix');
  });

  it('fails startup when two providers claim the same prefix', () => {
    expect(() => { callInvariant({ ...aligned, registry: [...registry, ...registry] }); })
      .toThrow('provider prefixes are not unique');
  });
});

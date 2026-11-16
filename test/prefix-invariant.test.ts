import { describe, expect, it } from 'vitest';
import { assertPrefixInvariant, type PrefixInvariantInputs } from '../src/server/providers/registry.js';
import type { ProviderDefinition } from '../src/server/providers/types.js';

const registry: readonly ProviderDefinition[] = [
  {
    id: 'github',
    prefix: 'github_',
    displayName: 'GitHub',
    mcpUrl: 'https://example.test/mcp',
    oauth: { kind: 'static', authorizationUrl: '', tokenUrl: '', scopes: [] },
    readAccountLabel: async () => '@tester',
  },
];

const aligned: PrefixInvariantInputs = {
  registry,
  namespaces: { github: 'github_' },
  apps: ['github'],
  credentialMapping: { github_: 'github' },
};

describe('provider prefix invariant', () => {
  it('accepts aligned registry, namespace, app, and credential mapping', () => {
    expect(() => {
      assertPrefixInvariant(aligned);
    }).not.toThrow();
  });

  it('passes on the registry the server actually boots with', () => {
    expect(() => {
      assertPrefixInvariant();
    }).not.toThrow();
  });

  it('fails startup when one character drifts', () => {
    expect(() => {
      assertPrefixInvariant({ ...aligned, namespaces: { github: 'github-' } });
    }).toThrow('github: namespace differs from registry prefix');
  });

  it('fails startup when a provider is absent from the supported apps', () => {
    expect(() => {
      assertPrefixInvariant({ ...aligned, apps: [] });
    }).toThrow('github: missing from supported apps');
  });

  it('fails startup when supported apps contain a provider absent from the registry', () => {
    expect(() => {
      assertPrefixInvariant({ ...aligned, apps: ['github', 'linear'] });
    }).toThrow('linear: supported app has no registry entry');
  });

  it('fails startup when the registry is missing an otherwise configured provider', () => {
    expect(() => {
      assertPrefixInvariant({ ...aligned, registry: [] });
    }).toThrow('github: namespace has no registry entry');
  });

  it('fails startup when the credential mapping points the prefix elsewhere', () => {
    expect(() => {
      assertPrefixInvariant({ ...aligned, credentialMapping: { github_: 'linear' } });
    }).toThrow('github: credential mapping differs from prefix');
  });

  it('fails startup when two providers claim the same prefix', () => {
    expect(() => {
      assertPrefixInvariant({ ...aligned, registry: [...registry, ...registry] });
    }).toThrow('provider prefixes are not unique');
  });

  it('fails startup when supported apps repeat a provider', () => {
    expect(() => {
      assertPrefixInvariant({ ...aligned, apps: ['github', 'github'] });
    }).toThrow('supported apps are not unique');
  });
});

describe('overlapping provider prefixes', () => {
  it('fails startup when one prefix starts with another', () => {
    const nested = {
      ...registry[0]!,
      id: 'github_enterprise',
      prefix: 'github_enterprise_',
    } as unknown as ProviderDefinition;

    expect(() => {
      assertPrefixInvariant({
        registry: [...registry, nested],
        namespaces: { github: 'github_', github_enterprise: 'github_enterprise_' },
        apps: ['github', 'github_enterprise'],
        credentialMapping: { github_: 'github', github_enterprise_: 'github_enterprise' },
      });
    }).toThrow('github_enterprise: prefix starts with the github prefix');
  });
});

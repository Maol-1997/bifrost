import type { Tool } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { ProviderDefinition } from '../src/server/providers/types.js';
import {
  effectivePolicyState,
  fingerprintToolDefinition,
  isToolEnabled,
  normalizeUpstreamTool,
  toolContractReview,
  toolPolicyReviewsMatchCurrentDefinitions,
  type StoredToolPolicy,
} from '../src/server/tools/catalog.js';

const provider: ProviderDefinition = {
  id: 'github',
  prefix: 'github_',
  displayName: 'GitHub',
  mcpUrl: 'https://example.test/mcp',
  oauth: { kind: 'static', authorizationUrl: '', tokenUrl: '', scopes: [] },
  readAccountLabel: async () => '@tester',
};

const readTool: Tool = {
  name: 'get_issue',
  title: 'Get issue',
  description: 'Read an issue.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};

function policy(toolName: string, fingerprint: string, state: StoredToolPolicy['state']): ReadonlyMap<string, StoredToolPolicy> {
  return new Map([[toolName, { toolName, fingerprint, state }]]);
}

describe('official MCP tool normalization', () => {
  it('prefixes upstream names and trusts only an explicit read-only hint', () => {
    const read = normalizeUpstreamTool(provider, readTool);
    const unknown = normalizeUpstreamTool(provider, {
      name: 'unknown', title: readTool.title, description: readTool.description, inputSchema: readTool.inputSchema,
    });

    expect(read.name).toBe('github_get_issue');
    expect(read.mutability).toBe('read');
    expect(unknown.mutability).toBe('write');
  });

  it('produces the same fingerprint regardless of object key order', () => {
    const reordered: Tool = {
      inputSchema: { properties: { id: { type: 'string' } }, type: 'object' },
      description: readTool.description, title: readTool.title, annotations: { readOnlyHint: true }, name: readTool.name,
    };
    expect(fingerprintToolDefinition('github', reordered)).toBe(fingerprintToolDefinition('github', readTool));
  });

  it('changes the fingerprint when the provider changes the contract', () => {
    const changed = { ...readTool, inputSchema: { type: 'object' as const, properties: { number: { type: 'number' } } } };
    expect(fingerprintToolDefinition('github', changed)).not.toBe(fingerprintToolDefinition('github', readTool));
  });
});

describe('deployment policy resolution', () => {
  const tool = normalizeUpstreamTool(provider, readTool);

  it('blocks a tool with no reviewed policy', () => {
    expect(effectivePolicyState(tool, new Map())).toBe('blocked');
  });

  it('blocks a changed definition even when its name was previously allowed', () => {
    expect(effectivePolicyState(tool, policy(tool.name, '0'.repeat(64), 'allowed_default_on'))).toBe('blocked');
  });

  it('uses the admin default only when the user has no preference', () => {
    const defaultOn = policy(tool.name, tool.fingerprint, 'allowed_default_on');
    const defaultOff = policy(tool.name, tool.fingerprint, 'allowed_default_off');
    expect(isToolEnabled(tool, defaultOn, new Map())).toBe(true);
    expect(isToolEnabled(tool, defaultOff, new Map())).toBe(false);
    expect(isToolEnabled(tool, defaultOn, new Map([[tool.name, false]]))).toBe(false);
    expect(isToolEnabled(tool, defaultOff, new Map([[tool.name, true]]))).toBe(true);
  });

  it('never lets a user preference override a blocked deployment policy', () => {
    expect(isToolEnabled(tool, new Map(), new Map([[tool.name, true]]))).toBe(false);
  });

  it('accepts a batch only when every reviewed fingerprint is current', () => {
    expect(toolPolicyReviewsMatchCurrentDefinitions([tool], [{ toolName: tool.name, fingerprint: tool.fingerprint }])).toBe(true);
  });

  it('rejects a batch containing a stale fingerprint', () => {
    expect(toolPolicyReviewsMatchCurrentDefinitions([tool], [{ toolName: tool.name, fingerprint: '0'.repeat(64) }])).toBe(false);
  });

  it('rejects a batch containing an unknown tool', () => {
    expect(toolPolicyReviewsMatchCurrentDefinitions([tool], [
      { toolName: tool.name, fingerprint: tool.fingerprint },
      { toolName: 'github_unknown', fingerprint: tool.fingerprint },
    ])).toBe(false);
  });

  it('rejects duplicate tools', () => {
    const review = { toolName: tool.name, fingerprint: tool.fingerprint };
    expect(toolPolicyReviewsMatchCurrentDefinitions([tool], [review, review])).toBe(false);
  });

  it('rejects empty batches', () => {
    expect(toolPolicyReviewsMatchCurrentDefinitions([tool], [])).toBe(false);
  });
});

describe('tool contract review', () => {
  const approvedTool = normalizeUpstreamTool(provider, readTool);

  it('classifies a tool with no stored policy as new', () => {
    expect(toolContractReview(approvedTool, new Map())).toEqual({ kind: 'new' });
  });

  it('classifies a matching fingerprint as approved', () => {
    expect(toolContractReview(
      approvedTool,
      policy(approvedTool.name, approvedTool.fingerprint, 'allowed_default_on'),
    )).toEqual({ kind: 'approved' });
  });

  it('reports that an older changed policy has no comparable snapshot', () => {
    expect(toolContractReview(
      approvedTool,
      policy(approvedTool.name, '0'.repeat(64), 'allowed_default_on'),
    )).toEqual({ kind: 'changed', changes: null });
  });

  it('describes exact contract changes against the approved snapshot', () => {
    const currentTool = normalizeUpstreamTool(provider, {
      ...readTool,
      description: 'Read an issue with optional comments.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          includeComments: { type: 'boolean' },
        },
      },
    });
    const policies = new Map<string, StoredToolPolicy>([[approvedTool.name, {
      toolName: approvedTool.name,
      fingerprint: approvedTool.fingerprint,
      contract: approvedTool.contract,
      state: 'allowed_default_on',
    }]]);

    expect(toolContractReview(currentTool, policies)).toEqual({
      kind: 'changed',
      changes: [
        {
          kind: 'changed',
          path: '/tool/description',
          before: 'Read an issue.',
          after: 'Read an issue with optional comments.',
        },
        {
          kind: 'added',
          path: '/tool/inputSchema/properties/includeComments',
          after: { type: 'boolean' },
        },
      ],
      truncated: false,
    });
  });

  it('caps oversized contract diffs and reports truncation', () => {
    const properties = Object.fromEntries(Array.from(
      { length: 101 },
      (_, index) => [`field${index.toString().padStart(3, '0')}`, { type: 'string' }],
    ));
    const previousTool = normalizeUpstreamTool(provider, {
      ...readTool,
      inputSchema: { type: 'object', properties: {} },
    });
    const currentTool = normalizeUpstreamTool(provider, {
      ...readTool,
      inputSchema: { type: 'object', properties },
    });
    const policies = new Map<string, StoredToolPolicy>([[previousTool.name, {
      toolName: previousTool.name,
      fingerprint: previousTool.fingerprint,
      contract: previousTool.contract,
      state: 'allowed_default_on',
    }]]);
    const review = toolContractReview(currentTool, policies);

    expect(review.kind).toBe('changed');
    expect(review.kind === 'changed' && review.changes?.length).toBe(100);
    expect(review.kind === 'changed' && review.changes !== null && review.truncated).toBe(true);
  });
});

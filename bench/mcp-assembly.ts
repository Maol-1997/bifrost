import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import type { Config } from '../src/server/config.js';
import type { Coordinator } from '../src/server/coordination.js';
import type { Database } from '../src/server/database/index.js';
import { createHumanMcpHandler } from '../src/server/mcp.js';
import type { OAuthService } from '../src/server/oauth.js';
import { PROVIDER_REGISTRY } from '../src/server/providers/registry.js';
import { decryptSecret, encryptSecret } from '../src/server/security/secrets.js';
import { normalizeUpstreamTool } from '../src/server/tools/catalog.js';
import { createInMemoryToolCacheStore } from '../src/server/tools/cache-store.js';
import { ToolDiscoveryCache } from '../src/server/tools/discovery-cache.js';
import { ToolDiscoveryService } from '../src/server/tools/discovery.js';
import { loadVisibleUserTools, type UserToolDependencies } from '../src/server/tools/user-toolset.js';

const TOOLS_PER_PROVIDER = 50;
const SAMPLES = 7;
const ITERATIONS = 200;
const userId = '11111111-1111-4111-8111-111111111111';
const store = createInMemoryToolCacheStore();
const cache = new ToolDiscoveryCache({ store });
const tools = PROVIDER_REGISTRY.flatMap((provider) => Array.from({ length: TOOLS_PER_PROVIDER }, (_, index) => normalizeUpstreamTool(provider, {
  name: `search_records_${index}`,
  description: `Search ${provider.displayName} records with pagination and filters. Tool ${index}.`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search expression' },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      filters: { type: 'object', properties: { state: { type: 'string', enum: ['open', 'closed'] }, labels: { type: 'array', items: { type: 'string' } } } },
    },
    required: ['query'],
  },
  outputSchema: { type: 'object', properties: { records: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } }, nextPage: { type: 'integer' } } },
  annotations: { readOnlyHint: true },
})));
for (const provider of PROVIDER_REGISTRY) {
  await cache.readFresh({ userId, providerId: provider.id }, async () => tools.filter((tool) => tool.providerId === provider.id));
}
const mounts = PROVIDER_REGISTRY.map((provider) => ({ providerId: provider.id, name: provider.displayName, prefix: provider.prefix, isMounted: true }));
const oauth = {} as OAuthService;
const policies = new Map(tools.map((tool) => [tool.name, { toolName: tool.name, fingerprint: tool.fingerprint, state: 'allowed_default_on' as const }]));
const dependencies: UserToolDependencies = {
  config: {} as Config,
  coordinator: {} as Coordinator,
  oauth,
  mounts,
  database: {
    connectedProviders: async () => new Set(PROVIDER_REGISTRY.map((provider) => provider.id)),
    hiddenProviders: async () => new Set(),
    toolPreferences: async () => new Map(),
    toolPolicyDecisions: async () => policies,
  } as unknown as Database,
  toolDiscovery: new ToolDiscoveryService({ oauth, mounts, store }),
};
const handler = createHumanMcpHandler(dependencies);
const authInfo = { token: 'benchmark', clientId: 'benchmark', scopes: ['mcp'], extra: { userId } };

async function request(method: string): Promise<unknown> {
  const response = await handler.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-method': method },
  }), {
    authInfo,
    parsedBody: { jsonrpc: '2.0', id: 1, method, params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} } } },
  });
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function measure(label: string, operation: () => unknown): Promise<void> {
  for (let iteration = 0; iteration < 50; iteration += 1) await operation();
  const samples = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const started = performance.now();
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) await operation();
    samples.push((performance.now() - started) / ITERATIONS);
  }
  samples.sort((left, right) => left - right);
  console.log(JSON.stringify({ label, tools: tools.length, medianMs: samples[Math.floor(SAMPLES / 2)], samplesMs: samples }));
}

const listing = await request('tools/list') as { result: { tools: unknown[] } };
assert.equal(listing.result.tools.length, tools.length);
await measure('visible tool loading (memory store, real discovery decode and policy filter)', () => loadVisibleUserTools({ userId, dependencies }));
await measure('MCP assembly + server/discover transport (stub DB, warm discovery)', () => request('server/discover'));
await measure('MCP assembly + tools/list serialization (stub DB, warm discovery)', () => request('tools/list'));
const encryptionKey = randomBytes(32);
const encrypted = encryptSecret(JSON.stringify({ accessToken: 'x'.repeat(512), refreshToken: 'y'.repeat(512) }), encryptionKey);
await measure('AES-256-GCM decrypt 1KB', () => decryptSecret(encrypted, encryptionKey));
await handler.close();

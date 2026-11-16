import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '../src/server/database/schema.js';
import { createToolPolicyStore } from '../src/server/database/tool-policies.js';
import { PROVIDER_REGISTRY } from '../src/server/providers/registry.js';
import { normalizeUpstreamTool } from '../src/server/tools/catalog.js';

const SAMPLES = 7;
const ITERATIONS = 100;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  // Session-local tables shadow real tables; this benchmark never writes user data.
  await client.query(
    'CREATE TEMP TABLE deployment_tool_policies (provider_id text, tool_name text, fingerprint text, contract jsonb, state text)',
  );
  const tools = PROVIDER_REGISTRY.flatMap((provider) =>
    Array.from({ length: 50 }, (_, index) =>
      normalizeUpstreamTool(provider, {
        name: `search_records_${index}`,
        description: `Search ${provider.displayName} records with pagination and filters.`,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 12 }, (_, field) => [
              `filter_${field}`,
              {
                type: 'string',
                description: `Optional search filter ${field} for ${provider.displayName} records. Omit to include all matching records.`,
              },
            ]),
          ),
          required: ['filter_0'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            records: {
              type: 'array',
              items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
            },
          },
        },
        annotations: { readOnlyHint: true },
      }),
    ),
  );
  for (const tool of tools) {
    await client.query('INSERT INTO deployment_tool_policies VALUES ($1, $2, $3, $4, $5)', [
      tool.providerId,
      tool.name,
      tool.fingerprint,
      tool.contract,
      'allowed_default_on',
    ]);
  }
  const database = drizzle({ client, schema });
  const policyStore = createToolPolicyStore(database);
  const operations = {
    'full policy reviews': () => policyStore.toolPolicies(),
    'policy decisions without contracts': () => policyStore.toolPolicyDecisions(),
  };
  const reviews = await policyStore.toolPolicies();
  const decisions = await policyStore.toolPolicyDecisions();
  assert.deepEqual(
    decisions,
    new Map(
      [...reviews].map(([name, policy]) => [
        name,
        {
          toolName: policy.toolName,
          fingerprint: policy.fingerprint,
          state: policy.state,
        },
      ]),
    ),
  );
  for (const [label, operation] of Object.entries(operations)) {
    const rows = await operation();
    assert.equal(rows.size, 300);
    const payloadBytes = Buffer.byteLength(JSON.stringify([...rows.values()]));
    for (let iteration = 0; iteration < 30; iteration += 1) await operation();
    const samples = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const started = performance.now();
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) await operation();
      samples.push((performance.now() - started) / ITERATIONS);
    }
    samples.sort((left, right) => left - right);
    console.log(
      JSON.stringify({
        label,
        rows: rows.size,
        payloadBytes,
        medianMs: samples[Math.floor(SAMPLES / 2)],
        samplesMs: samples,
      }),
    );
  }
} finally {
  await client.end();
}

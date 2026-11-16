import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { integrationEnvironment, resetIntegrationDatabase } from '../test/integration/environment.js';
import { createIntegrationHarness, type IntegrationHarness, type McpResponse } from '../test/integration/harness.js';
import type { FakeUpstreamTool } from '../test/integration/fake-upstream.js';

const { values: options } = parseArgs({
  options: {
    'upstream-latency-ms': { type: 'string', default: '0' },
    tools: { type: 'string', default: '40' },
    warm: { type: 'string', default: '300' },
    cold: { type: 'string', default: '100' },
    save: { type: 'string' },
  },
});
const UPSTREAM_LATENCY_MS = Number(options['upstream-latency-ms']);
const TOOL_COUNT = Number(options.tools);
const WARM_SAMPLES = Number(options.warm);
const COLD_SAMPLES = Number(options.cold);
const WARMUP_REQUESTS = 30;
// GitHub allows 80 tool calls per user per minute; spreading calls over enough
// users keeps the benchmark measuring latency instead of the rate limiter.
const USERS = 25;

type Scenario = 'tools/list warm' | 'tools/list cold' | 'tools/call warm' | 'tools/call cold';
type Agent = { userId: string; bearer: string };
type Result = { scenario: Scenario; samples: number; p50Ms: number; p95Ms: number; p99Ms: number; meanMs: number };

const environment = integrationEnvironment();
await resetIntegrationDatabase(environment.databaseUrl);
const harness = await createIntegrationHarness({ environment });

try {
  const tools: FakeUpstreamTool[] = Array.from({ length: TOOL_COUNT }, (_, index) => ({
    name: index === 0 ? 'echo' : `tool_${index}`,
    description: `Synthetic provider tool ${index} with a realistic one-line description.`,
    readOnly: index % 2 === 0,
  }));
  harness.upstream.setTools(tools);
  const adminUserId = await harness.createUser();
  await harness.connectProvider(adminUserId);
  await harness.decideTools(
    adminUserId,
    Object.fromEntries(tools.map((tool) => [`github_${tool.name}`, 'allowed_default_on'])),
  );
  const agents = await Promise.all(
    Array.from({ length: USERS }, async () => {
      const userId = await harness.createUser();
      await harness.connectProvider(userId);
      return { userId, bearer: await harness.issueBearer(userId) };
    }),
  );
  harness.upstream.latencyMs = UPSTREAM_LATENCY_MS;

  const list = (agent: Agent): Promise<McpResponse> => harness.listTools(agent.bearer);
  const call = (agent: Agent): Promise<McpResponse> =>
    harness.callTool(agent.bearer, 'github_echo', { message: 'benchmark' });
  const results = [
    await measure(harness, agents, 'tools/list warm', list, WARM_SAMPLES),
    await measure(harness, agents, 'tools/list cold', list, COLD_SAMPLES),
    await measure(harness, agents, 'tools/call warm', call, WARM_SAMPLES),
    await measure(harness, agents, 'tools/call cold', call, COLD_SAMPLES),
  ];

  const report = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    upstreamLatencyMs: UPSTREAM_LATENCY_MS,
    toolsPerProvider: TOOL_COUNT,
    results,
  };
  console.table(results);
  if (options.save) {
    await mkdir('bench/results', { recursive: true });
    await writeFile(options.save, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Saved ${options.save}`);
  }
} finally {
  await harness.close();
}

/**
 * Sequential requests, one at a time, so each sample is a latency and not a
 * queueing artifact. "Cold" drops the caller's cached listing before every
 * sample (outside the timed window), forcing a blocking upstream discovery.
 */
async function measure(
  bench: IntegrationHarness,
  agents: readonly Agent[],
  scenario: Scenario,
  send: (agent: Agent) => Promise<McpResponse>,
  samples: number,
): Promise<Result> {
  const cold = scenario.endsWith('cold');
  const timings: number[] = [];
  for (let index = 0; index < WARMUP_REQUESTS + samples; index += 1) {
    const agent = agents[index % agents.length]!;
    if (cold) await bench.toolDiscovery.invalidateProvider(agent.userId, 'github');
    const startedAt = performance.now();
    const response = await send(agent);
    const elapsed = performance.now() - startedAt;
    assert.equal(response.status, 200, `${scenario} returned HTTP ${response.status}`);
    assert.equal(response.body.error, undefined, `${scenario} failed: ${JSON.stringify(response.body.error)}`);
    assert.notEqual(response.body.result?.isError, true, `${scenario} failed: ${JSON.stringify(response.body.result)}`);
    if (index >= WARMUP_REQUESTS) timings.push(elapsed);
  }
  timings.sort((left, right) => left - right);
  return {
    scenario,
    samples,
    p50Ms: round(percentile(timings, 0.5)),
    p95Ms: round(percentile(timings, 0.95)),
    p99Ms: round(percentile(timings, 0.99)),
    meanMs: round(timings.reduce((sum, value) => sum + value, 0) / timings.length),
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

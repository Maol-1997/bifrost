import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toolNotFound } from '../helpers/mcp-protocol.js';
import { integrationEnvironment } from './environment.js';
import { createIntegrationHarness, type IntegrationHarness, type McpResponse } from './harness.js';

let harness: IntegrationHarness;
let adminUserId: string;

beforeAll(async () => {
  harness = await createIntegrationHarness({ environment: integrationEnvironment() });
  adminUserId = await harness.createUser();
  await harness.connectProvider(adminUserId);
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  harness.upstream.reset();
  await harness.decideTools(adminUserId, {
    github_echo: 'allowed_default_on',
    github_create_note: 'allowed_default_on',
  });
  harness.upstream.reset();
});

/** A tool that was never registered for this request fails as an unknown tool, not as a failed call. */
const notFound = (response: McpResponse): string | undefined => toolNotFound(response.body);

async function connectedAgent(): Promise<{ userId: string; bearer: string; accessToken: string }> {
  const userId = await harness.createUser();
  const accessToken = `access-${userId}`;
  await harness.connectProvider(userId, { accessToken });
  return { userId, bearer: await harness.issueBearer(userId), accessToken };
}

describe('MCP end to end against a real database, Redis and upstream', () => {
  it('lists approved tools and proxies a call with the caller’s own provider credential', async () => {
    const agent = await connectedAgent();

    const listed = await harness.listTools(agent.bearer);
    const called = await harness.callTool(agent.bearer, 'github_echo', { message: 'hello' });

    expect({
      listStatus: listed.status,
      tools: listed.body.result?.tools?.map((tool) => tool.name).sort(),
      callStatus: called.status,
      content: called.body.result?.content,
      isError: called.body.result?.isError,
      upstreamCall: harness.upstream.requests.find((request) => request.method === 'tools/call'),
    }).toEqual({
      listStatus: 200,
      tools: ['github_create_note', 'github_echo'],
      callStatus: 200,
      content: [{ type: 'text', text: 'echo:hello' }],
      isError: undefined,
      upstreamCall: {
        method: 'tools/call',
        authorization: `Bearer ${agent.accessToken}`,
        toolName: 'echo',
        arguments: { message: 'hello' },
      },
    });
  });

  it('rejects a bearer token Bifrost never issued before touching any upstream', async () => {
    const response = await harness.listTools('not-a-real-token');

    expect({ status: response.status, upstreamRequests: harness.upstream.requests.length })
      .toEqual({ status: 401, upstreamRequests: 0 });
  });

  it('lists upstream once on a cold cache and serves the warm cache afterwards', async () => {
    const agent = await connectedAgent();

    await harness.listTools(agent.bearer);
    const listsAfterCold = harness.upstream.count('tools/list');
    await harness.listTools(agent.bearer);
    await harness.callTool(agent.bearer, 'github_echo', { message: 'warm' });
    await harness.listTools(agent.bearer);

    expect({ listsAfterCold, listsAfterWarm: harness.upstream.count('tools/list') })
      .toEqual({ listsAfterCold: 1, listsAfterWarm: 1 });
  });

  it('goes back upstream once the cached listing is invalidated', async () => {
    const agent = await connectedAgent();
    await harness.listTools(agent.bearer);

    await harness.toolDiscovery.invalidateProvider(agent.userId, 'github');
    const listed = await harness.listTools(agent.bearer);

    expect({ lists: harness.upstream.count('tools/list'), tools: listed.body.result?.tools?.length })
      .toEqual({ lists: 2, tools: 2 });
  });

  it('applies an administrator block to the very next call, with the listing still cached', async () => {
    const agent = await connectedAgent();
    const before = await harness.callTool(agent.bearer, 'github_echo', { message: 'before' });

    await harness.decideTools(adminUserId, { github_echo: 'blocked' });
    harness.upstream.requests.length = 0;
    const after = await harness.callTool(agent.bearer, 'github_echo', { message: 'after' });
    const listed = await harness.listTools(agent.bearer);

    expect({
      before: before.body.result?.isError,
      after: notFound(after),
      upstreamCalls: harness.upstream.count('tools/call'),
      upstreamLists: harness.upstream.count('tools/list'),
      listed: listed.body.result?.tools?.map((tool) => tool.name),
    }).toEqual({
      before: undefined,
      after: 'Tool github_echo not found',
      upstreamCalls: 0,
      upstreamLists: 0,
      listed: ['github_create_note'],
    });
  });

  it('applies a user switching a tool off to the very next call', async () => {
    const agent = await connectedAgent();
    await harness.callTool(agent.bearer, 'github_echo', { message: 'before' });

    await harness.database.setToolPreference(agent.userId, 'github_echo', false);
    harness.upstream.requests.length = 0;
    const after = await harness.callTool(agent.bearer, 'github_echo', { message: 'after' });

    expect({ after: notFound(after), upstreamCalls: harness.upstream.count('tools/call') })
      .toEqual({ after: 'Tool github_echo not found', upstreamCalls: 0 });
  });

  it('refuses tools that are not visible to the caller and never forwards them', async () => {
    const agent = await connectedAgent();
    const unconnected = await harness.createUser();
    const unconnectedBearer = await harness.issueBearer(unconnected);

    const neverApproved = await harness.callTool(agent.bearer, 'github_hidden_probe', { message: 'x' });
    const unknown = await harness.callTool(agent.bearer, 'github_does_not_exist', { message: 'x' });
    const otherProvider = await harness.callTool(agent.bearer, 'linear_echo', { message: 'x' });
    const notConnected = await harness.callTool(unconnectedBearer, 'github_echo', { message: 'x' });
    const notConnectedList = await harness.listTools(unconnectedBearer);

    expect({
      rejected: [neverApproved, unknown, otherProvider, notConnected].map(notFound),
      notConnectedTools: notConnectedList.body.result?.tools,
      upstreamCalls: harness.upstream.count('tools/call'),
    }).toEqual({
      rejected: [
        'Tool github_hidden_probe not found',
        'Tool github_does_not_exist not found',
        'Tool linear_echo not found',
        'Tool github_echo not found',
      ],
      notConnectedTools: [],
      upstreamCalls: 0,
    });
  });
});

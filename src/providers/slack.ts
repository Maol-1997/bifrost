import { z } from 'zod';
import { fetchJson } from './http.js';
import { defineTool, type ProviderDefinition, type ToolExecutionContext } from './types.js';

type SlackResponse = { ok: boolean; error?: string } & Record<string, unknown>;

async function slackApi(method: string, input: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown> {
  const result = await fetchJson<SlackResponse>(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${context.accessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(input),
  }, context.signal);
  if (!result.ok) throw new Error(`Slack request failed: ${result.error ?? 'unknown error'}`);
  return result;
}

const channelSchema = z.object({ channel: z.string().min(1).max(100) });
const tools = [
  defineTool({
    name: 'slack_search_messages', title: 'Search messages', description: 'Search messages visible to the authenticated Slack user.', mutability: 'read',
    inputSchema: z.object({ query: z.string().min(1).max(500), count: z.number().int().min(1).max(100).default(20) }),
    execute: (input, context) => slackApi('search.messages', input, context),
  }),
  defineTool({
    name: 'slack_read_channel_history', title: 'Read channel history', description: 'Read recent messages from a Slack channel.', mutability: 'read',
    inputSchema: channelSchema.extend({ limit: z.number().int().min(1).max(100).default(20) }),
    execute: (input, context) => slackApi('conversations.history', input, context),
  }),
  defineTool({
    name: 'slack_get_thread', title: 'Get thread', description: 'Read a Slack message thread.', mutability: 'read',
    inputSchema: channelSchema.extend({ ts: z.string().min(1).max(30), limit: z.number().int().min(1).max(100).default(100) }),
    execute: (input, context) => slackApi('conversations.replies', input, context),
  }),
  defineTool({
    name: 'slack_list_channels', title: 'List channels', description: 'List Slack channels visible to the authenticated user.', mutability: 'read',
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(100) }),
    execute: (input, context) => slackApi('conversations.list', { ...input, types: 'public_channel,private_channel' }, context),
  }),
  defineTool({
    name: 'slack_post_message', title: 'Post message', description: 'Post a message to a Slack channel.', mutability: 'write',
    inputSchema: channelSchema.extend({ text: z.string().min(1).max(40_000), threadTs: z.string().max(30).optional() }),
    execute: ({ channel, text, threadTs }, context) => slackApi('chat.postMessage', { channel, text, thread_ts: threadTs }, context),
  }),
];

const authTestSchema = z.object({ user: z.string().min(1), team: z.string().min(1).optional() });

export const slackProvider: ProviderDefinition = {
  id: 'slack', prefix: 'slack_', displayName: 'Slack',
  authorizationUrl: 'https://slack.com/oauth/v2/authorize', tokenUrl: 'https://slack.com/api/oauth.v2.access',
  scopes: ['channels:read', 'groups:read', 'channels:history', 'groups:history', 'search:read', 'chat:write'], tools,
  readAccountLabel: async (accessToken, signal) => {
    const result = await fetchJson<SlackResponse>('https://slack.com/api/auth.test', {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=utf-8' }, body: '{}',
    }, signal);
    if (!result.ok) throw new Error(`Slack identity lookup failed: ${result.error ?? 'unknown error'}`);
    const identity = authTestSchema.parse(result);
    // The workspace matters here in a way it does not for the others: the same
    // person can be in several Slacks, and "@sam" alone would not say which.
    return identity.team ? `@${identity.user} · ${identity.team}` : `@${identity.user}`;
  },
};

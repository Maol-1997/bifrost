import { z } from 'zod';
import { fetchJson, type JsonValue } from './http.js';
import type { ProviderDefinition, ProviderRequestContext } from './types.js';

/** Slack answers 200 to everything and signals failure inside the body. */
const slackEnvelopeSchema = z.object({ ok: z.boolean(), error: z.string().optional() });

async function slackApi(
  method: string,
  input: Record<string, unknown>,
  context: ProviderRequestContext,
): Promise<JsonValue> {
  const result = await fetchJson(
    `https://slack.com/api/${method}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${context.accessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(input),
    },
    context.signal,
  );
  const envelope = slackEnvelopeSchema.parse(result);
  if (!envelope.ok) throw new Error(`Slack request failed: ${envelope.error ?? 'unknown error'}`);
  return result;
}

const authTestSchema = z.object({ user: z.string().min(1), team: z.string().min(1).optional() });

export const slackProvider: ProviderDefinition = {
  id: 'slack',
  prefix: 'slack_',
  displayName: 'Slack',
  mcpUrl: 'https://mcp.slack.com/mcp',
  oauth: {
    kind: 'static',
    authorizationUrl: 'https://slack.com/oauth/v2_user/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.user.access',
    scopes: [
      'canvases:read',
      'canvases:write',
      'channels:history',
      'channels:read',
      'channels:write',
      'chat:write',
      'emoji:read',
      'files:read',
      'groups:history',
      'groups:read',
      'groups:write',
      'im:history',
      'im:write',
      'mpim:history',
      'mpim:read',
      'mpim:write',
      'reactions:write',
      'search:read.files',
      'search:read.im',
      'search:read.mpim',
      'search:read.private',
      'search:read.public',
      'search:read.users',
      'users:read',
      'users:read.email',
    ],
  },
  readAccountLabel: async (accessToken, signal) => {
    const identity = authTestSchema.parse(await slackApi('auth.test', {}, { accessToken, signal }));
    // The workspace matters here in a way it does not for the others: the same
    // person can be in several Slacks, and "@sam" alone would not say which.
    return identity.team ? `@${identity.user} · ${identity.team}` : `@${identity.user}`;
  },
};

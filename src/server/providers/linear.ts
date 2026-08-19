import { z } from 'zod';
import { fetchJson, type JsonValue } from './http.js';
import type { ProviderDefinition, ProviderRequestContext } from './types.js';

const jsonValueSchema = z.json();
const graphQlEnvelopeSchema = z.object({
  data: jsonValueSchema.optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

async function linearGraphQl(query: string, variables: Record<string, unknown>, context: ProviderRequestContext): Promise<JsonValue> {
  const result = graphQlEnvelopeSchema.parse(await fetchJson('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${context.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  }, context.signal));
  if (result.errors?.length) throw new Error(`Linear request failed: ${result.errors[0]?.message ?? 'unknown GraphQL error'}`);
  return result.data ?? null;
}

const viewerSchema = z.object({ viewer: z.object({ email: z.string().min(1) }) });

export const linearProvider: ProviderDefinition = {
  id: 'linear', prefix: 'linear_', displayName: 'Linear',
  mcpUrl: 'https://mcp.linear.app/mcp',
  oauth: {
    kind: 'dynamic',
    issuer: 'https://mcp.linear.app',
    discoveryAlgorithm: 'oidc',
    authorizationUrl: 'https://mcp.linear.app/authorize',
    tokenUrl: 'https://mcp.linear.app/token',
    resource: 'https://mcp.linear.app/mcp',
    scopes: ['read', 'write'],
  },
  readAccountLabel: async (accessToken, signal) => {
    const data = await linearGraphQl('query Viewer{viewer{email}}', {}, { accessToken, signal });
    return viewerSchema.parse(data).viewer.email;
  },
};

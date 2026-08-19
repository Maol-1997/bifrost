import type { OpenAIToolOptions } from '@ai-sdk/openai';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { AppDependencies } from '../http/context.js';
import type { HumanIdentity } from '../mcp.js';
import { PROVIDER_REGISTRY, SUPPORTED_APPS } from '../providers/registry.js';
import type { ProviderId } from '../providers/types.js';
import { isAdministrator } from '../security/access.js';
import {
  effectivePolicyState,
  toolPolicyReviewsMatchCurrentDefinitions,
  TOOL_POLICY_STATES,
  type StoredToolPolicy,
} from './catalog.js';
import { discoverProviderTools, discoverProviderToolsFresh } from './discovery.js';

const ADMIN_TOOL_NAMESPACE = {
  name: 'bifrost_admin',
  description: 'Administrative tools for reviewing MCP providers and changing deployment tool policies in Bifrost.',
} as const;
const ADMIN_TOOL_OPTIONS = {
  deferLoading: true,
  namespace: ADMIN_TOOL_NAMESPACE,
} satisfies OpenAIToolOptions;
const providerIdSchema = z.enum(SUPPORTED_APPS).describe('The MCP provider to inspect or administer.');
const toolNameSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/);
const policyStateSchema = z.enum(TOOL_POLICY_STATES);
const listProviderToolsSchema = z.object({
  providerId: providerIdSchema,
  query: z.string().trim().min(1).max(100).optional().describe('Optional case-insensitive search over tool name, title, and description.'),
  mutability: z.enum(['read', 'write']).optional().describe('Optional filter for read-only or write-capable tools.'),
  states: z.array(policyStateSchema).min(1).optional().describe('Optional deployment policy states to include.'),
});
const setToolPoliciesSchema = z.object({
  providerId: providerIdSchema,
  changes: z.array(z.object({
    toolName: toolNameSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/).describe('The fingerprint returned by list_mcp_tools.'),
    state: policyStateSchema.describe('blocked disables the tool; allowed_default_off permits it off by default; allowed_default_on permits it on by default.'),
  })).min(1).max(250),
});

type AdminAgentToolRequest = {
  dependencies: AppDependencies;
  identity: HumanIdentity;
  signal: AbortSignal;
};

export async function createAdminAgentTools(request: AdminAgentToolRequest): Promise<ToolSet> {
  if (!await hasAdministratorAccess(request)) return {};

  return {
    bifrost_admin_list_mcp_providers: tool({
      title: 'List MCP providers',
      description: 'List every MCP provider managed by Bifrost, whether this admin account is connected, whether it is mounted, and counts for its stored deployment policies.',
      inputSchema: z.object({}),
      providerOptions: { openai: ADMIN_TOOL_OPTIONS },
      metadata: { source: 'bifrost-admin' },
      execute: async () => {
        await assertAdministratorAccess(request);
        return listMcpProviders(request);
      },
    }),
    bifrost_admin_list_mcp_tools: tool({
      title: 'List MCP tools',
      description: 'List tools discovered from one MCP provider with compact review metadata, current deployment policy, review status, and fingerprint. Use filters to narrow large providers. Returns fingerprints required for batch policy changes.',
      inputSchema: listProviderToolsSchema,
      providerOptions: { openai: ADMIN_TOOL_OPTIONS },
      metadata: { source: 'bifrost-admin' },
      execute: async (input, options) => {
        await assertAdministratorAccess(request);
        return listMcpTools({
          ...request,
          input,
          signal: options.abortSignal ?? request.signal,
        });
      },
    }),
    bifrost_admin_set_mcp_tool_policies: tool({
      title: 'Set MCP tool policies',
      description: 'Atomically change deployment policies for up to 250 tools from one MCP provider. Always use fingerprints from list_mcp_tools. The entire batch is rejected if any definition changed, tool is unknown, or tool appears twice.',
      inputSchema: setToolPoliciesSchema,
      providerOptions: { openai: ADMIN_TOOL_OPTIONS },
      metadata: { source: 'bifrost-admin' },
      execute: async (input, options) => {
        await assertAdministratorAccess(request);
        return setMcpToolPolicies({
          ...request,
          input,
          signal: options.abortSignal ?? request.signal,
        });
      },
    }),
  };
}

async function listMcpProviders(request: AdminAgentToolRequest) {
  const [connectedProviders, policies] = await Promise.all([
    request.dependencies.database.connectedProviders(request.identity.userId),
    request.dependencies.database.toolPolicies(),
  ]);
  return {
    providers: PROVIDER_REGISTRY.map((provider) => ({
      providerId: provider.id,
      displayName: provider.displayName,
      connected: connectedProviders.has(provider.id),
      mounted: request.dependencies.mounts.some((mount) => mount.providerId === provider.id && mount.isMounted),
      policyCounts: countProviderPolicies(provider.id, policies),
    })),
  };
}

async function listMcpTools(request: AdminAgentToolRequest & {
  input: z.infer<typeof listProviderToolsSchema>;
}) {
  const connectedProviders = await request.dependencies.database.connectedProviders(request.identity.userId);
  if (!connectedProviders.has(request.input.providerId)) {
    return { providerId: request.input.providerId, status: 'not-connected' as const, totalTools: 0, matchedTools: 0, tools: [] };
  }
  const [discovery, policies] = await Promise.all([
    discoverProviderTools({
      userId: request.identity.userId,
      providerId: request.input.providerId,
      oauth: request.dependencies.oauth,
      mounts: request.dependencies.mounts,
      signal: request.signal,
    }),
    request.dependencies.database.toolPolicies(),
  ]);
  const normalizedQuery = request.input.query?.toLowerCase();
  const tools = discovery.tools
    .filter((entry) => request.input.mutability === undefined || entry.mutability === request.input.mutability)
    .filter((entry) => request.input.states === undefined || request.input.states.includes(effectivePolicyState(entry, policies)))
    .filter((entry) => normalizedQuery === undefined || `${entry.name} ${entry.title} ${entry.description}`.toLowerCase().includes(normalizedQuery))
    .map((entry) => {
      const storedPolicy = policies.get(entry.name);
      return {
        toolName: entry.name,
        title: entry.title,
        description: entry.description,
        mutability: entry.mutability,
        state: effectivePolicyState(entry, policies),
        needsReview: storedPolicy?.fingerprint !== entry.fingerprint,
        fingerprint: entry.fingerprint,
      };
    });
  return {
    providerId: request.input.providerId,
    status: 'ready' as const,
    totalTools: discovery.tools.length,
    matchedTools: tools.length,
    tools,
  };
}

async function setMcpToolPolicies(request: AdminAgentToolRequest & {
  input: z.infer<typeof setToolPoliciesSchema>;
}) {
  const connectedProviders = await request.dependencies.database.connectedProviders(request.identity.userId);
  if (!connectedProviders.has(request.input.providerId)) {
    throw new Error(`The admin account is not connected to ${request.input.providerId}`);
  }
  const discovery = await discoverProviderToolsFresh({
    userId: request.identity.userId,
    providerId: request.input.providerId,
    oauth: request.dependencies.oauth,
    mounts: request.dependencies.mounts,
    signal: request.signal,
  });
  if (!toolPolicyReviewsMatchCurrentDefinitions(discovery.tools, request.input.changes)) {
    throw new Error('The batch was not saved because a selected tool changed, is unknown, or appears more than once. List the tools again before retrying.');
  }
  await request.dependencies.database.setToolPolicies(request.input.changes.map((change) => ({
    providerId: request.input.providerId,
    toolName: change.toolName,
    fingerprint: change.fingerprint,
    state: change.state,
    updatedByUserId: request.identity.userId,
  })));
  return {
    providerId: request.input.providerId,
    updatedTools: request.input.changes.length,
    policyCounts: countChanges(request.input.changes),
  };
}

function countProviderPolicies(providerId: ProviderId, policies: ReadonlyMap<string, StoredToolPolicy>) {
  const prefix = PROVIDER_REGISTRY.find((provider) => provider.id === providerId)?.prefix;
  if (!prefix) throw new Error(`Unknown provider: ${providerId}`);
  return countChanges([...policies.values()].filter((policy) => policy.toolName.startsWith(prefix)));
}

function countChanges(changes: readonly { state: z.infer<typeof policyStateSchema> }[]) {
  return {
    blocked: changes.filter((change) => change.state === 'blocked').length,
    allowedDefaultOff: changes.filter((change) => change.state === 'allowed_default_off').length,
    allowedDefaultOn: changes.filter((change) => change.state === 'allowed_default_on').length,
  };
}

async function hasAdministratorAccess(request: AdminAgentToolRequest): Promise<boolean> {
  if (request.identity.kind !== 'browser') return false;
  const user = await request.dependencies.database.getUser(request.identity.userId);
  return user !== undefined && isAdministrator(user.email, request.dependencies.config.adminEmails);
}

async function assertAdministratorAccess(request: AdminAgentToolRequest): Promise<void> {
  if (!await hasAdministratorAccess(request)) throw new Error('Administrator access required');
}

import type { OpenAIToolOptions } from '@ai-sdk/openai';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { AppDependencies } from '../http/context.js';
import type { BrowserIdentity } from '../mcp.js';
import { PROVIDER_REGISTRY, SUPPORTED_APPS } from '../providers/registry.js';
import type { ProviderId } from '../providers/types.js';
import { isAdministrator } from '../security/access.js';
import {
  effectivePolicyState,
  mcpToolNameSchema,
  toolContractReview,
  TOOL_POLICY_STATES,
  type StoredToolPolicy,
} from './catalog.js';
import type { ToolDiscoveryService } from './discovery.js';
import { applyToolPolicies, countToolPolicyStates } from './policy.js';
import { providerAgentNoteInstructions, providerAgentNoteSchema } from './provider-agent-notes.js';

const ADMIN_TOOL_NAMESPACE = {
  name: 'bifrost_admin',
  description: 'Administrative tools for reviewing MCP providers, changing deployment tool policies, and maintaining one internal agent note per provider in Bifrost.',
} as const;
const ADMIN_TOOL_OPTIONS = {
  deferLoading: true,
  namespace: ADMIN_TOOL_NAMESPACE,
} satisfies OpenAIToolOptions;
const providerIdSchema = z.enum(SUPPORTED_APPS).describe('The MCP provider to inspect or administer.');
const policyStateSchema = z.enum(TOOL_POLICY_STATES);
const reviewKindSchema = z.enum(['approved', 'new', 'changed']);
const listProviderToolsSchema = z.object({
  providerId: providerIdSchema,
  query: z.string().trim().min(1).max(100).optional().describe('Optional case-insensitive search over tool name, title, and description.'),
  mutability: z.enum(['read', 'write']).optional().describe('Optional filter for read-only or write-capable tools.'),
  states: z.array(policyStateSchema).min(1).optional().describe('Optional deployment policy states to include.'),
  reviewKinds: z.array(reviewKindSchema).min(1).optional().describe('Optional review classification filter: approved, new, or changed.'),
});
const setToolPoliciesSchema = z.object({
  providerId: providerIdSchema,
  changes: z.array(z.object({
    toolName: mcpToolNameSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/).describe('The fingerprint returned by list_mcp_tools.'),
    state: policyStateSchema.describe('blocked disables the tool; allowed_default_off permits it off by default; allowed_default_on permits it on by default.'),
  })).min(1).max(250),
});
const setProviderNoteSchema = z.object({
  providerId: providerIdSchema,
  note: providerAgentNoteSchema.describe('The complete replacement note. Preserve still-relevant context from the previous note and never include secrets.'),
});
const clearProviderNoteSchema = z.object({ providerId: providerIdSchema });

/**
 * The intersection is deliberate: once `toolDiscovery` is part of
 * `AppDependencies` it collapses to `AppDependencies` and nothing here changes.
 */
type AdminAgentDependencies = AppDependencies & { toolDiscovery: ToolDiscoveryService };

type AdminAgentToolRequest = {
  dependencies: AdminAgentDependencies;
  identity: BrowserIdentity;
  signal: AbortSignal;
};

export type AdminAgentContext = {
  tools: ToolSet;
  instructions: string;
};

export async function createAdminAgentContext(request: AdminAgentToolRequest): Promise<AdminAgentContext> {
  if (!await hasAdministratorAccess(request)) return { tools: {}, instructions: '' };
  const notes = await request.dependencies.database.providerAgentNotes(request.identity.userId);

  return {
    instructions: providerAgentNoteInstructions(notes),
    tools: createAdminAgentTools(request),
  };
}

function createAdminAgentTools(request: AdminAgentToolRequest): ToolSet {
  return {
    bifrost_admin_list_mcp_providers: tool({
      title: 'List MCP providers',
      description: 'List every MCP provider managed by Bifrost, its current agent note, whether this admin account is connected, whether it is mounted, and counts for its stored deployment policies.',
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
      description: 'List tools discovered from one MCP provider with current deployment policy, whether each tool is new or changed, exact contract changes when available, and fingerprint. Use filters to narrow large providers. Returns fingerprints required for batch policy changes.',
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
    bifrost_admin_set_mcp_note: tool({
      title: 'Set MCP note',
      description: 'Save the complete internal note for one MCP provider. This replaces its previous note. Use it only for durable user preferences or provider-specific working context, never secrets.',
      inputSchema: setProviderNoteSchema,
      providerOptions: { openai: ADMIN_TOOL_OPTIONS },
      metadata: { source: 'bifrost-admin' },
      execute: async (input) => {
        await assertAdministratorAccess(request);
        await request.dependencies.database.setProviderAgentNote(
          request.identity.userId,
          input.providerId,
          input.note,
        );
        return { providerId: input.providerId, note: input.note, status: 'saved' as const };
      },
    }),
    bifrost_admin_clear_mcp_note: tool({
      title: 'Clear MCP note',
      description: 'Delete the internal note for one MCP provider when it is no longer useful.',
      inputSchema: clearProviderNoteSchema,
      providerOptions: { openai: ADMIN_TOOL_OPTIONS },
      metadata: { source: 'bifrost-admin' },
      execute: async (input) => {
        await assertAdministratorAccess(request);
        await request.dependencies.database.clearProviderAgentNote(request.identity.userId, input.providerId);
        return { providerId: input.providerId, status: 'cleared' as const };
      },
    }),
  };
}

async function listMcpProviders(request: AdminAgentToolRequest) {
  const [connectedProviders, policies, notes] = await Promise.all([
    request.dependencies.database.connectedProviders(request.identity.userId),
    request.dependencies.database.toolPolicies(),
    request.dependencies.database.providerAgentNotes(request.identity.userId),
  ]);
  return {
    providers: PROVIDER_REGISTRY.map((provider) => ({
      providerId: provider.id,
      displayName: provider.displayName,
      agentNote: notes.get(provider.id)?.note ?? null,
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
    request.dependencies.toolDiscovery.discoverProvider({
      userId: request.identity.userId,
      providerId: request.input.providerId,
      signal: request.signal,
    }),
    request.dependencies.database.toolPolicies(),
  ]);
  const normalizedQuery = request.input.query?.toLowerCase();
  const tools = discovery.tools
    .map((entry) => ({ entry, review: toolContractReview(entry, policies) }))
    .filter(({ entry }) => request.input.mutability === undefined || entry.mutability === request.input.mutability)
    .filter(({ entry }) => request.input.states === undefined || request.input.states.includes(effectivePolicyState(entry, policies)))
    .filter(({ review }) => request.input.reviewKinds === undefined || request.input.reviewKinds.includes(review.kind))
    .filter(({ entry }) => normalizedQuery === undefined || `${entry.name} ${entry.title} ${entry.description}`.toLowerCase().includes(normalizedQuery))
    .map(({ entry, review }) => {
      return {
        toolName: entry.name,
        title: entry.title,
        description: entry.description,
        mutability: entry.mutability,
        state: effectivePolicyState(entry, policies),
        needsReview: review.kind !== 'approved',
        review,
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
  const outcome = await applyToolPolicies({
    userId: request.identity.userId,
    providerId: request.input.providerId,
    changes: request.input.changes,
    signal: request.signal,
    dependencies: request.dependencies,
  });
  if (outcome.status === 'stale') {
    throw new Error('The batch was not saved because a selected tool changed, is unknown, or appears more than once. List the tools again before retrying.');
  }
  return {
    providerId: outcome.providerId,
    updatedTools: outcome.changes.length,
    policyCounts: outcome.counts,
  };
}

function countProviderPolicies(providerId: ProviderId, policies: ReadonlyMap<string, StoredToolPolicy>) {
  const prefix = PROVIDER_REGISTRY.find((provider) => provider.id === providerId)?.prefix;
  if (!prefix) throw new Error(`Unknown provider: ${providerId}`);
  return countToolPolicyStates([...policies.values()].filter((policy) => policy.toolName.startsWith(prefix)));
}

async function hasAdministratorAccess(request: AdminAgentToolRequest): Promise<boolean> {
  const user = await request.dependencies.database.getUser(request.identity.userId);
  return user !== undefined && isAdministrator(user.email, request.dependencies.config.adminEmails);
}

async function assertAdministratorAccess(request: AdminAgentToolRequest): Promise<void> {
  if (!await hasAdministratorAccess(request)) throw new Error('Administrator access required');
}

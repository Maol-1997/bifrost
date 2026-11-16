import type { AnthropicToolOptions } from '@ai-sdk/anthropic';
import { tool, type ToolApprovalStatus, type ToolSet } from 'ai';
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
  type DiscoveredTool,
  type StoredToolPolicy,
} from './catalog.js';
import type { ToolPolicyOrigin } from '../database/tool-policies.js';
import { clearToolRule, saveToolRule, toolRuleInstructionsSchema } from './auto-policy.js';
import { applyToolPolicies, countToolPolicyStates } from './policy.js';
import { providerAgentNoteInstructions, providerAgentNoteSchema } from './provider-agent-notes.js';
import { isUncertainProbability, RULE_MATCH_AT, RULE_MISMATCH_AT } from './rule-classifier.js';

// Deferred like the provider tools; the chat finds them with tool search.
const ADMIN_TOOL_OPTIONS = { deferLoading: true } as const satisfies AnthropicToolOptions;
const ADMIN_TOOLS_INSTRUCTIONS =
  "You are talking to a Bifrost administrator. Tools starting with bifrost_admin_ review MCP providers, change deployment tool policies, manage each provider's automatic tool rule, and maintain one internal agent note per provider. Find them with tool search.";
const providerIdSchema = z.enum(SUPPORTED_APPS).describe('The MCP provider to inspect or administer.');
const policyStateSchema = z.enum(TOOL_POLICY_STATES);
const reviewKindSchema = z.enum(['approved', 'new', 'changed']);
const listProviderToolsSchema = z.object({
  providerId: providerIdSchema,
  query: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe('Optional case-insensitive search over tool name, title, and description.'),
  mutability: z.enum(['read', 'write']).optional().describe('Optional filter for read-only or write-capable tools.'),
  states: z.array(policyStateSchema).min(1).optional().describe('Optional deployment policy states to include.'),
  reviewKinds: z
    .array(reviewKindSchema)
    .min(1)
    .optional()
    .describe('Optional review classification filter: approved, new, or changed.'),
  decidedBy: z
    .enum(['rule', 'admin'])
    .optional()
    .describe('Optional filter: tools whose current policy was set by the automatic rule, or by an administrator.'),
  uncertainOnly: z.boolean().optional().describe('Only tools the automatic rule could not clearly classify.'),
});
const setToolPoliciesSchema = z.object({
  providerId: providerIdSchema,
  changes: z
    .array(
      z.object({
        toolName: mcpToolNameSchema,
        fingerprint: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .describe('The fingerprint returned by list_mcp_tools.'),
        state: policyStateSchema.describe(
          'blocked disables the tool; allowed_default_off permits it off by default; allowed_default_on permits it on by default.',
        ),
      }),
    )
    .min(1)
    .max(250),
});
const setProviderNoteSchema = z.object({
  providerId: providerIdSchema,
  note: providerAgentNoteSchema.describe(
    'The complete replacement note. Preserve still-relevant context from the previous note and never include secrets.',
  ),
});
const clearProviderNoteSchema = z.object({ providerId: providerIdSchema });
const providerOnlySchema = z.object({ providerId: providerIdSchema });
const setToolRuleSchema = z.object({
  providerId: providerIdSchema,
  instructions: toolRuleInstructionsSchema.describe(
    'The complete replacement rule in plain language, e.g. "Only tools that create, edit, merge or push files to a pull request."',
  ),
});
const RULE_BEHAVIOUR = `Tools are classified against the rule: probability >= ${RULE_MATCH_AT} becomes allowed_default_on, anything lower becomes allowed_default_off, and between ${RULE_MISMATCH_AT} and ${RULE_MATCH_AT} is flagged uncertain. A rule only decides tools with no policy yet, and its own earlier decisions when the rule changes. It never blocks a tool, never overrides an administrator's decision, and never re-approves a tool whose definition changed; those stay blocked until an administrator reviews them.`;

type AdminAgentToolRequest = {
  dependencies: AppDependencies;
  identity: BrowserIdentity;
  signal: AbortSignal;
};

/**
 * Tools that change what every user's agents can do. The chat model runs in the
 * same loop as web search and provider tool output, so text from any of those
 * could ask for one of these calls. Each call therefore stops until the
 * administrator approves its exact input in the chat. The approval is not
 * signed: the browser sending it already holds an administrator session that
 * can make the same changes through the admin API.
 */
export const ADMIN_TOOLS_REQUIRING_APPROVAL = [
  'bifrost_admin_set_mcp_tool_policies',
  'bifrost_admin_set_mcp_tool_rule',
  'bifrost_admin_clear_mcp_tool_rule',
] as const;

const APPROVAL_INSTRUCTIONS =
  'Changes to tool policies and automatic rules wait for the administrator to approve them in the chat. ' +
  'If a change is denied, do not retry it; ask the administrator what to do instead.';

export type AdminAgentContext = {
  tools: ToolSet;
  instructions: string;
  toolApproval: Readonly<Record<string, ToolApprovalStatus>>;
};

export async function createAdminAgentContext(request: AdminAgentToolRequest): Promise<AdminAgentContext> {
  if (!(await hasAdministratorAccess(request))) return { tools: {}, instructions: '', toolApproval: {} };
  const notes = await request.dependencies.database.providerAgentNotes(request.identity.userId);

  return {
    instructions: [ADMIN_TOOLS_INSTRUCTIONS, providerAgentNoteInstructions(notes), APPROVAL_INSTRUCTIONS].join('\n\n'),
    tools: createAdminAgentTools(request),
    toolApproval: Object.fromEntries(ADMIN_TOOLS_REQUIRING_APPROVAL.map((name) => [name, 'user-approval'] as const)),
  };
}

function createAdminAgentTools(request: AdminAgentToolRequest): ToolSet {
  return {
    bifrost_admin_list_mcp_providers: tool({
      title: 'List MCP providers',
      description:
        'List every MCP provider managed by Bifrost, its current agent note, its automatic tool rule, whether this admin account is connected, whether it is mounted, and counts for its stored deployment policies.',
      inputSchema: z.object({}),
      providerOptions: { anthropic: ADMIN_TOOL_OPTIONS },
      metadata: { source: 'bifrost-admin' },
      execute: async () => {
        await assertAdministratorAccess(request);
        return listMcpProviders(request);
      },
    }),
    bifrost_admin_list_mcp_tools: tool({
      title: 'List MCP tools',
      description:
        "List tools discovered from one MCP provider with current deployment policy, who decided it (automatic rule or administrator) with the rule's probability, whether each tool is new or changed, exact contract changes when available, and fingerprint. Use filters to narrow large providers. Returns fingerprints required for batch policy changes; setting a policy by hand makes it an administrator decision the rule no longer changes.",
      inputSchema: listProviderToolsSchema,
      providerOptions: { anthropic: ADMIN_TOOL_OPTIONS },
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
      description:
        'Atomically change deployment policies for up to 250 tools from one MCP provider. Always use fingerprints from list_mcp_tools. The entire batch is rejected if any definition changed, tool is unknown, or tool appears twice.',
      inputSchema: setToolPoliciesSchema,
      providerOptions: { anthropic: ADMIN_TOOL_OPTIONS },
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
    bifrost_admin_get_mcp_tool_rule: tool({
      title: 'Get MCP tool rule',
      description: `Read the automatic tool rule for one MCP provider, its revision, and whether automatic rules are available on this server. ${RULE_BEHAVIOUR}`,
      inputSchema: providerOnlySchema,
      providerOptions: { anthropic: ADMIN_TOOL_OPTIONS },
      metadata: { source: 'bifrost-admin' },
      execute: async (input) => {
        await assertAdministratorAccess(request);
        const rule = await request.dependencies.database.toolRule(input.providerId);
        return {
          providerId: input.providerId,
          isAvailable: Boolean(request.dependencies.config.OPENROUTER_API_KEY),
          rule: rule
            ? { instructions: rule.instructions, revision: rule.revision, updatedAt: rule.updatedAt.toISOString() }
            : null,
        };
      },
    }),
    bifrost_admin_set_mcp_tool_rule: tool({
      title: 'Set MCP tool rule',
      description: `Create or replace the automatic tool rule for one MCP provider and apply it immediately to tools it has not decided yet. ${RULE_BEHAVIOUR} The administrator approves each call in the chat before it runs.`,
      inputSchema: setToolRuleSchema,
      providerOptions: { anthropic: ADMIN_TOOL_OPTIONS },
      metadata: { source: 'bifrost-admin' },
      execute: async (input, options) => {
        await assertAdministratorAccess(request);
        const result = await saveToolRule({
          userId: request.identity.userId,
          providerId: input.providerId,
          instructions: input.instructions,
          signal: options.abortSignal ?? request.signal,
          dependencies: request.dependencies,
        });
        if (result.status === 'not-configured')
          throw new Error('Automatic rules need OPENROUTER_API_KEY on the server');
        return { providerId: input.providerId, ...result };
      },
    }),
    bifrost_admin_clear_mcp_tool_rule: tool({
      title: 'Clear MCP tool rule',
      description:
        'Remove the automatic tool rule for one MCP provider. Policies it already set stay as they are; new tools stay blocked until reviewed.',
      inputSchema: providerOnlySchema,
      providerOptions: { anthropic: ADMIN_TOOL_OPTIONS },
      metadata: { source: 'bifrost-admin' },
      execute: async (input) => {
        await assertAdministratorAccess(request);
        await clearToolRule({ providerId: input.providerId, dependencies: request.dependencies });
        return { providerId: input.providerId, status: 'cleared' as const };
      },
    }),
    bifrost_admin_set_mcp_note: tool({
      title: 'Set MCP note',
      description:
        'Save the complete internal note for one MCP provider. This replaces its previous note. Use it only for durable user preferences or provider-specific working context, never secrets.',
      inputSchema: setProviderNoteSchema,
      providerOptions: { anthropic: ADMIN_TOOL_OPTIONS },
      metadata: { source: 'bifrost-admin' },
      execute: async (input) => {
        await assertAdministratorAccess(request);
        await request.dependencies.database.setProviderAgentNote(request.identity.userId, input.providerId, input.note);
        return { providerId: input.providerId, note: input.note, status: 'saved' as const };
      },
    }),
    bifrost_admin_clear_mcp_note: tool({
      title: 'Clear MCP note',
      description: 'Delete the internal note for one MCP provider when it is no longer useful.',
      inputSchema: clearProviderNoteSchema,
      providerOptions: { anthropic: ADMIN_TOOL_OPTIONS },
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
  const [connectedProviders, policies, notes, rules] = await Promise.all([
    request.dependencies.database.connectedProviders(request.identity.userId),
    request.dependencies.database.toolPolicies(),
    request.dependencies.database.providerAgentNotes(request.identity.userId),
    request.dependencies.database.toolRules(),
  ]);
  return {
    providers: PROVIDER_REGISTRY.map((provider) => ({
      providerId: provider.id,
      displayName: provider.displayName,
      agentNote: notes.get(provider.id)?.note ?? null,
      automaticRule: rules.get(provider.id)?.instructions ?? null,
      connected: connectedProviders.has(provider.id),
      mounted: request.dependencies.mounts.some((mount) => mount.providerId === provider.id && mount.isMounted),
      policyCounts: countProviderPolicies(provider.id, policies),
    })),
  };
}

async function listMcpTools(
  request: AdminAgentToolRequest & {
    input: z.infer<typeof listProviderToolsSchema>;
  },
) {
  const connectedProviders = await request.dependencies.database.connectedProviders(request.identity.userId);
  if (!connectedProviders.has(request.input.providerId)) {
    return {
      providerId: request.input.providerId,
      status: 'not-connected' as const,
      totalTools: 0,
      matchedTools: 0,
      tools: [],
    };
  }
  const [discovery, policies, origins] = await Promise.all([
    request.dependencies.toolDiscovery.discoverProvider({
      userId: request.identity.userId,
      providerId: request.input.providerId,
      signal: request.signal,
    }),
    request.dependencies.database.toolPolicies(),
    request.dependencies.database.toolPolicyOrigins(request.input.providerId),
  ]);
  const normalizedQuery = request.input.query?.toLowerCase();
  const tools = discovery.tools
    .map((entry) => ({
      entry,
      review: toolContractReview(entry, policies),
      decision: currentDecision(entry, origins.get(entry.name)),
    }))
    .filter(({ decision }) => request.input.decidedBy === undefined || decision.decidedBy === request.input.decidedBy)
    .filter(({ decision }) => request.input.uncertainOnly !== true || decision.isUncertain)
    .filter(({ entry }) => request.input.mutability === undefined || entry.mutability === request.input.mutability)
    .filter(
      ({ entry }) =>
        request.input.states === undefined || request.input.states.includes(effectivePolicyState(entry, policies)),
    )
    .filter(({ review }) => request.input.reviewKinds === undefined || request.input.reviewKinds.includes(review.kind))
    .filter(
      ({ entry }) =>
        normalizedQuery === undefined ||
        `${entry.name} ${entry.title} ${entry.description}`.toLowerCase().includes(normalizedQuery),
    )
    .map(({ entry, review, decision }) => {
      return {
        toolName: entry.name,
        title: entry.title,
        description: entry.description,
        mutability: entry.mutability,
        state: effectivePolicyState(entry, policies),
        needsReview: review.kind !== 'approved',
        review,
        ...decision,
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

async function setMcpToolPolicies(
  request: AdminAgentToolRequest & {
    input: z.infer<typeof setToolPoliciesSchema>;
  },
) {
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
    throw new Error(
      'The batch was not saved because a selected tool changed, is unknown, or appears more than once. List the tools again before retrying.',
    );
  }
  return {
    providerId: outcome.providerId,
    updatedTools: outcome.changes.length,
    policyCounts: outcome.counts,
  };
}

/** Who decided the policy for this exact definition; null when nobody has yet. */
function currentDecision(tool: DiscoveredTool, origin: ToolPolicyOrigin | undefined) {
  if (!origin || origin.fingerprint !== tool.fingerprint)
    return { decidedBy: null, ruleProbability: null, isUncertain: false };
  if (origin.source === 'admin' || origin.autoProbability === null)
    return { decidedBy: 'admin' as const, ruleProbability: null, isUncertain: false };
  return {
    decidedBy: 'rule' as const,
    ruleProbability: origin.autoProbability,
    isUncertain: isUncertainProbability(origin.autoProbability),
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
  if (!(await hasAdministratorAccess(request))) throw new Error('Administrator access required');
}

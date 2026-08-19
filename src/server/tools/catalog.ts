import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/client';
import type { ProviderDefinition, ProviderId, ToolMutability } from '../providers/types.js';

export const TOOL_POLICY_STATES = ['blocked', 'allowed_default_off', 'allowed_default_on'] as const;
export type ToolPolicyState = (typeof TOOL_POLICY_STATES)[number];

export type StoredToolPolicy = {
  toolName: string;
  fingerprint: string;
  state: ToolPolicyState;
};

export type ToolPolicyReview = Pick<StoredToolPolicy, 'toolName' | 'fingerprint'>;

export type DiscoveredTool = {
  providerId: ProviderId;
  upstreamName: string;
  name: string;
  title: string;
  description: string;
  mutability: ToolMutability;
  fingerprint: string;
  inputSchema: Tool['inputSchema'];
  outputSchema?: Tool['outputSchema'];
  annotations?: Tool['annotations'];
};

export function normalizeUpstreamTool(provider: ProviderDefinition, upstreamTool: Tool): DiscoveredTool {
  return {
    providerId: provider.id,
    upstreamName: upstreamTool.name,
    name: `${provider.prefix}${upstreamTool.name}`,
    title: upstreamTool.title ?? upstreamTool.annotations?.title ?? upstreamTool.name,
    description: upstreamTool.description ?? `Use ${upstreamTool.name} through ${provider.displayName}.`,
    mutability: upstreamTool.annotations?.readOnlyHint === true ? 'read' : 'write',
    fingerprint: fingerprintToolDefinition(provider.id, upstreamTool),
    inputSchema: upstreamTool.inputSchema,
    ...(upstreamTool.outputSchema ? { outputSchema: upstreamTool.outputSchema } : {}),
    ...(upstreamTool.annotations ? { annotations: upstreamTool.annotations } : {}),
  };
}

export function fingerprintToolDefinition(providerId: ProviderId, upstreamTool: Tool): string {
  return createHash('sha256')
    .update(stableStringify({ providerId, tool: upstreamTool }))
    .digest('hex');
}

export function effectivePolicyState(
  tool: DiscoveredTool,
  policies: ReadonlyMap<string, StoredToolPolicy>,
): ToolPolicyState {
  const policy = policies.get(tool.name);
  return policy?.fingerprint === tool.fingerprint ? policy.state : 'blocked';
}

export function isToolEnabled(
  tool: DiscoveredTool,
  policies: ReadonlyMap<string, StoredToolPolicy>,
  userPreferences: ReadonlyMap<string, boolean>,
): boolean {
  const state = effectivePolicyState(tool, policies);
  if (state === 'blocked') return false;
  return userPreferences.get(tool.name) ?? state === 'allowed_default_on';
}

export function toolPolicyReviewsMatchCurrentDefinitions(
  tools: readonly DiscoveredTool[],
  reviews: readonly ToolPolicyReview[],
): boolean {
  if (reviews.length === 0) return false;
  const fingerprintByToolName = new Map(tools.map((tool) => [tool.name, tool.fingerprint]));
  const reviewedToolNames = new Set<string>();
  return reviews.every((review) => {
    if (reviewedToolNames.has(review.toolName)) return false;
    reviewedToolNames.add(review.toolName);
    return fingerprintByToolName.get(review.toolName) === review.fingerprint;
  });
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)]),
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

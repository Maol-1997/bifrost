import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/client';
import type { ProviderDefinition, ProviderId, ToolMutability } from '../providers/types.js';

export const TOOL_POLICY_STATES = ['blocked', 'allowed_default_off', 'allowed_default_on'] as const;
export type ToolPolicyState = (typeof TOOL_POLICY_STATES)[number];
const MAX_CONTRACT_CHANGES = 100;

export type ToolContractSnapshot = {
  readonly providerId: ProviderId;
  readonly tool: Readonly<Record<string, unknown>>;
};
export type ToolContractChange =
  | { kind: 'added'; path: string; after: unknown }
  | { kind: 'removed'; path: string; before: unknown }
  | { kind: 'changed'; path: string; before: unknown; after: unknown };
export type ToolContractReview =
  | { kind: 'approved' }
  | { kind: 'new' }
  | { kind: 'changed'; changes: null }
  | { kind: 'changed'; changes: readonly ToolContractChange[]; truncated: boolean };

export type StoredToolPolicy = {
  toolName: string;
  fingerprint: string;
  state: ToolPolicyState;
  contract?: ToolContractSnapshot;
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
  contract: ToolContractSnapshot;
  inputSchema: Tool['inputSchema'];
  outputSchema?: Tool['outputSchema'];
  annotations?: Tool['annotations'];
};

export function normalizeUpstreamTool(provider: ProviderDefinition, upstreamTool: Tool): DiscoveredTool {
  const contract = toolContractSnapshot(provider.id, upstreamTool);
  return {
    providerId: provider.id,
    upstreamName: upstreamTool.name,
    name: `${provider.prefix}${upstreamTool.name}`,
    title: upstreamTool.title ?? upstreamTool.annotations?.title ?? upstreamTool.name,
    description: upstreamTool.description ?? `Use ${upstreamTool.name} through ${provider.displayName}.`,
    mutability: upstreamTool.annotations?.readOnlyHint === true ? 'read' : 'write',
    fingerprint: fingerprintToolContract(contract),
    contract,
    inputSchema: upstreamTool.inputSchema,
    ...(upstreamTool.outputSchema ? { outputSchema: upstreamTool.outputSchema } : {}),
    ...(upstreamTool.annotations ? { annotations: upstreamTool.annotations } : {}),
  };
}

export function fingerprintToolDefinition(providerId: ProviderId, upstreamTool: Tool): string {
  return fingerprintToolContract(toolContractSnapshot(providerId, upstreamTool));
}

export function toolContractReview(
  tool: DiscoveredTool,
  policies: ReadonlyMap<string, StoredToolPolicy>,
): ToolContractReview {
  const policy = policies.get(tool.name);
  if (!policy) return { kind: 'new' };
  if (policy.fingerprint === tool.fingerprint) return { kind: 'approved' };
  if (!policy.contract) return { kind: 'changed', changes: null };

  const changes = contractChanges(policy.contract, tool.contract);
  return {
    kind: 'changed',
    changes: changes.slice(0, MAX_CONTRACT_CHANGES),
    truncated: changes.length > MAX_CONTRACT_CHANGES,
  };
}

function toolContractSnapshot(providerId: ProviderId, upstreamTool: Tool): ToolContractSnapshot {
  const snapshot: unknown = JSON.parse(stableStringify({ providerId, tool: upstreamTool }));
  if (!isJsonObject(snapshot) || typeof snapshot.providerId !== 'string' || !isJsonObject(snapshot.tool)) {
    throw new Error('MCP tool contract could not be normalized');
  }
  return snapshot as ToolContractSnapshot;
}

function fingerprintToolContract(contract: ToolContractSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify(contract))
    .digest('hex');
}

function contractChanges(
  before: unknown,
  after: unknown,
): ToolContractChange[] {
  const changes: ToolContractChange[] = [];
  collectContractChanges(before, after, '', changes);
  return changes;
}

function collectContractChanges(
  before: unknown,
  after: unknown,
  path: string,
  changes: ToolContractChange[],
): void {
  if (changes.length > MAX_CONTRACT_CHANGES || JSON.stringify(before) === JSON.stringify(after)) return;
  if (!isContractObject(before) || !isContractObject(after)) {
    changes.push({ kind: 'changed', path: path || '/', before, after });
    return;
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    if (changes.length > MAX_CONTRACT_CHANGES) return;
    const nextPath = `${path}/${escapeJsonPointerSegment(key)}`;
    if (!(key in before)) {
      changes.push({ kind: 'added', path: nextPath, after: contractValueAt(after, key) });
      continue;
    }
    if (!(key in after)) {
      changes.push({ kind: 'removed', path: nextPath, before: contractValueAt(before, key) });
      continue;
    }
    collectContractChanges(
      contractValueAt(before, key),
      contractValueAt(after, key),
      nextPath,
      changes,
    );
  }
}

function contractValueAt(
  object: Readonly<Record<string, unknown>>,
  key: string,
): unknown {
  const value = object[key];
  if (value === undefined) throw new Error(`MCP tool contract value is missing: ${key}`);
  return value;
}

function isContractObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return isJsonObject(value) && !Array.isArray(value);
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
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

export function contractForToolPolicyReview(
  tools: readonly DiscoveredTool[],
  review: ToolPolicyReview,
): ToolContractSnapshot {
  const tool = tools.find((entry) => (
    entry.name === review.toolName && entry.fingerprint === review.fingerprint
  ));
  if (!tool) throw new Error(`Verified MCP tool contract is missing: ${review.toolName}`);
  return tool.contract;
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

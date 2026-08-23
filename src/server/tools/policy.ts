import type { Database } from '../database/index.js';
import type { ProviderId } from '../providers/types.js';
import {
  contractForToolPolicyReview,
  toolPolicyReviewsMatchCurrentDefinitions,
  type ToolPolicyState,
} from './catalog.js';
import type { ToolDiscoveryService } from './discovery.js';
import type { ToolCacheHint } from './discovery-cache.js';

export type ToolPolicyChange = {
  toolName: string;
  fingerprint: string;
  state: ToolPolicyState;
};

export type ToolPolicyCounts = {
  blocked: number;
  allowedDefaultOff: number;
  allowedDefaultOn: number;
};

/**
 * The narrow slice of the browser event bus this needs. Declared here so the
 * policy flow does not reach into the HTTP layer, and so a caller can hand it
 * anything that fans the two events out.
 */
export type ToolPolicyBroadcaster = {
  broadcast(event: 'providers-changed' | 'admin-tools-changed'): Promise<void>;
};

export type ToolPolicyDependencies = {
  database: Pick<Database, 'setToolPolicies'>;
  toolDiscovery: ToolDiscoveryService;
  events: ToolPolicyBroadcaster;
};

export type ApplyToolPoliciesRequest = {
  userId: string;
  providerId: ProviderId;
  changes: readonly ToolPolicyChange[];
  signal?: AbortSignal;
  dependencies: ToolPolicyDependencies;
};

export type ApplyToolPoliciesResult =
  | { status: 'stale' }
  | {
    status: 'applied';
    providerId: ProviderId;
    changes: readonly ToolPolicyChange[];
    counts: ToolPolicyCounts;
    cache: ToolCacheHint;
  };

/**
 * The one path that changes deployment tool policy, shared by the admin HTTP
 * route and the admin chat tool so neither can drift into approving a
 * definition the other would have rejected.
 *
 * The batch is all-or-nothing. A stale result means at least one selected tool
 * changed, is unknown, or appears twice, and nothing was written.
 */
export async function applyToolPolicies(request: ApplyToolPoliciesRequest): Promise<ApplyToolPoliciesResult> {
  const { database, events, toolDiscovery } = request.dependencies;
  // Deliberately fresh rather than cached: approval is a decision about a
  // definition as it stands right now, and this same read is what leaves every
  // worker serving the listing the administrator actually agreed to.
  const discovery = await toolDiscovery.discoverProviderFresh({
    userId: request.userId,
    providerId: request.providerId,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (!toolPolicyReviewsMatchCurrentDefinitions(discovery.tools, request.changes)) {
    return { status: 'stale' };
  }

  await database.setToolPolicies(request.changes.map((change) => ({
    providerId: request.providerId,
    toolName: change.toolName,
    fingerprint: change.fingerprint,
    contract: contractForToolPolicyReview(discovery.tools, change),
    state: change.state,
    updatedByUserId: request.userId,
  })));

  // Policies are deployment-wide, so this is not one person's tool list that
  // just changed; it is everyone's.
  await events.broadcast('providers-changed');
  await events.broadcast('admin-tools-changed');
  return {
    status: 'applied',
    providerId: request.providerId,
    changes: request.changes,
    counts: countToolPolicyStates(request.changes),
    cache: discovery.cache,
  };
}

export function countToolPolicyStates(
  policies: readonly { state: ToolPolicyState }[],
): ToolPolicyCounts {
  return {
    blocked: policies.filter((policy) => policy.state === 'blocked').length,
    allowedDefaultOff: policies.filter((policy) => policy.state === 'allowed_default_off').length,
    allowedDefaultOn: policies.filter((policy) => policy.state === 'allowed_default_on').length,
  };
}

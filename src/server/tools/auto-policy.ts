import { z } from 'zod';
import type { Coordinator } from '../coordination.js';
import type { Database } from '../database/index.js';
import type { ToolPolicyOrigin, ToolRule } from '../database/tool-policies.js';
import { errorSummary, logger } from '../logger.js';
import type { ProviderId } from '../providers/types.js';
import type { DiscoveredTool } from './catalog.js';
import type { ToolDiscoveryService } from './discovery.js';
import { autoPolicyFor, classifyToolsAgainstRule, type RuleClassifierConfig } from './rule-classifier.js';

// Long enough that a failing classifier is not hammered by every discovery,
// short enough that a new tool is not left blocked for long once it recovers.
const FAILURE_BACKOFF_SECONDS = 300;

export type AutoPolicyDependencies = {
  config: RuleClassifierConfig;
  database: Pick<Database, 'toolRule' | 'toolPolicyOrigins' | 'setAutoToolPolicies'>;
  coordinator: Pick<Coordinator, 'withLock' | 'setEphemeral' | 'peekEphemeral'>;
  events: { broadcast(event: 'providers-changed' | 'admin-tools-changed'): Promise<void> };
  classify?: typeof classifyToolsAgainstRule;
};

export const toolRuleInstructionsSchema = z.string().trim().min(1).max(1000);

export type ToolRuleDependencies = AutoPolicyDependencies & {
  database: AutoPolicyDependencies['database'] & Pick<Database, 'setToolRule' | 'clearToolRule' | 'connectedProviders'>;
  toolDiscovery: Pick<ToolDiscoveryService, 'discoverProviderFresh'>;
};

export type ToolRuleApplication = AutoPolicyOutcome['status'] | 'not-connected' | 'failed';

export type SaveToolRuleResult =
  | { status: 'not-configured' }
  | { status: 'saved'; revision: number; classification: ToolRuleApplication };

export type AutoPolicyOutcome =
  | { status: 'not-configured' | 'no-rule' | 'busy' | 'backing-off' }
  | { status: 'applied'; classified: number; written: number };

/**
 * The tools a rule still has to decide: those with no policy, those whose
 * definition changed since the policy was written, and those the rule itself
 * decided under an older wording. A person's decision on the current
 * definition is never among them.
 */
export function pendingAutoPolicyTools(
  tools: readonly DiscoveredTool[],
  origins: ReadonlyMap<string, ToolPolicyOrigin>,
  rule: Pick<ToolRule, 'revision'>,
): readonly DiscoveredTool[] {
  return tools.filter((tool) => {
    const origin = origins.get(tool.name);
    if (!origin || origin.fingerprint !== tool.fingerprint) return true;
    return origin.source === 'auto' && (origin.ruleRevision ?? 0) < rule.revision;
  });
}

/**
 * Applies the provider's rule to whatever in this listing it has not decided
 * yet. Fails closed: if the classifier cannot answer for every pending tool,
 * nothing is written and those tools keep whatever policy they had, which for
 * a new definition means blocked.
 */
export async function reconcileAutoPolicies(request: {
  providerId: ProviderId;
  tools: readonly DiscoveredTool[];
  dependencies: AutoPolicyDependencies;
}): Promise<AutoPolicyOutcome> {
  const { config, coordinator, database, events } = request.dependencies;
  const classify = request.dependencies.classify ?? classifyToolsAgainstRule;
  if (!config.OPENROUTER_API_KEY) return { status: 'not-configured' };
  const rule = await database.toolRule(request.providerId);
  if (!rule) return { status: 'no-rule' };
  // Keyed by revision so saving a new rule is never held back by the old one's failure.
  const backoffKey = `auto-policy-backoff:${request.providerId}:${rule.revision}`;
  if (await coordinator.peekEphemeral(backoffKey)) return { status: 'backing-off' };
  const providerTools = request.tools.filter((tool) => tool.providerId === request.providerId);
  if (pendingAutoPolicyTools(providerTools, await database.toolPolicyOrigins(request.providerId), rule).length === 0) {
    return { status: 'applied', classified: 0, written: 0 };
  }

  const lock = { isHeld: false };
  try {
    return await coordinator.withLock(`auto-policy:${request.providerId}`, async () => {
      lock.isHeld = true;
      // Re-read under the lock: another worker may have just done this work.
      const pending = pendingAutoPolicyTools(providerTools, await database.toolPolicyOrigins(request.providerId), rule);
      if (pending.length === 0) return { status: 'applied', classified: 0, written: 0 } as const;
      let probabilities: ReadonlyMap<string, number>;
      try {
        probabilities = await classify({ rule: rule.instructions, tools: pending, config });
      } catch (error) {
        await coordinator.setEphemeral(backoffKey, '1', FAILURE_BACKOFF_SECONDS);
        throw error;
      }
      const written = await database.setAutoToolPolicies(pending.map((tool) => {
        const autoProbability = probabilities.get(tool.name);
        if (autoProbability === undefined) throw new Error(`Missing classification for ${tool.name}`);
        return {
          providerId: request.providerId,
          toolName: tool.name,
          fingerprint: tool.fingerprint,
          contract: tool.contract,
          state: autoPolicyFor(autoProbability).state,
          autoProbability,
          ruleRevision: rule.revision,
        };
      }));
      if (written.length > 0) {
        // Policies are deployment-wide, so every signed-in browser may be showing a stale list.
        await events.broadcast('providers-changed');
        await events.broadcast('admin-tools-changed');
      }
      return { status: 'applied', classified: pending.length, written: written.length } as const;
    });
  } catch (error) {
    // Only a lock another worker holds fails before the operation starts.
    if (!lock.isHeld) return { status: 'busy' };
    throw error;
  }
}

/**
 * The one path that saves a provider rule, shared by the admin HTTP route and
 * the admin chat tool. Saving applies the rule right away to the
 * administrator's own fresh listing so its effect is visible; everyone else's
 * listings pick it up on their next discovery. A failed classification does not
 * undo the save: it is retried on the next discovery.
 */
export async function saveToolRule(request: {
  userId: string;
  providerId: ProviderId;
  instructions: string;
  signal?: AbortSignal;
  dependencies: ToolRuleDependencies;
}): Promise<SaveToolRuleResult> {
  const { config, database, events } = request.dependencies;
  if (!config.OPENROUTER_API_KEY) return { status: 'not-configured' };
  const rule = await database.setToolRule({
    providerId: request.providerId,
    instructions: request.instructions,
    updatedByUserId: request.userId,
  });
  await events.broadcast('admin-tools-changed');
  return { status: 'saved', revision: rule.revision, classification: await applyRuleToAdministratorListing(request) };
}

/** Policies the rule already decided stay as they are; new definitions go back to blocked. */
export async function clearToolRule(request: {
  providerId: ProviderId;
  dependencies: Pick<ToolRuleDependencies, 'database' | 'events'>;
}): Promise<void> {
  await request.dependencies.database.clearToolRule(request.providerId);
  await request.dependencies.events.broadcast('admin-tools-changed');
}

async function applyRuleToAdministratorListing(request: {
  userId: string;
  providerId: ProviderId;
  signal?: AbortSignal;
  dependencies: ToolRuleDependencies;
}): Promise<ToolRuleApplication> {
  const { database, toolDiscovery } = request.dependencies;
  if (!(await database.connectedProviders(request.userId)).has(request.providerId)) return 'not-connected';
  try {
    const discovery = await toolDiscovery.discoverProviderFresh({
      userId: request.userId,
      providerId: request.providerId,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const outcome = await reconcileAutoPolicies({
      providerId: request.providerId,
      tools: discovery.tools,
      dependencies: request.dependencies,
    });
    return outcome.status;
  } catch (error) {
    logger.warn({ providerId: request.providerId, ...errorSummary(error) }, 'Applying an automatic tool rule failed');
    return 'failed';
  }
}

/** For discovery: never delays or fails the listing that noticed new tools. */
export function reconcileAutoPoliciesInBackground(request: Parameters<typeof reconcileAutoPolicies>[0]): void {
  void reconcileAutoPolicies(request)
    .then((outcome) => {
      if (outcome.status === 'applied' && outcome.written > 0) {
        logger.info({ providerId: request.providerId, ...outcome }, 'Applied automatic tool policies');
      }
    })
    .catch((error: unknown) => {
      logger.warn({ providerId: request.providerId, ...errorSummary(error) }, 'Automatic tool policy classification failed');
    });
}

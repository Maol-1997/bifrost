import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ProviderId } from '../providers/types.js';
import {
  reconcileToolPreferences,
  type StoredToolPolicy,
  type ToolContractSnapshot,
  type ToolPolicySource,
  type ToolPolicyState,
} from '../tools/catalog.js';
import type { AppDatabase, AppTransaction } from './client.js';
import { deploymentToolPolicies, deploymentToolRules, userToolPreferences } from './schema.js';

type ToolPolicyWrite = {
  providerId: ProviderId;
  toolName: string;
  fingerprint: string;
  contract: ToolContractSnapshot;
  state: ToolPolicyState;
  updatedByUserId: string;
};

export type AutoToolPolicyWrite = Omit<ToolPolicyWrite, 'updatedByUserId' | 'state'> & {
  state: Exclude<ToolPolicyState, 'blocked'>;
  autoProbability: number;
  ruleRevision: number;
};

export type ToolPolicyOrigin = {
  fingerprint: string;
  source: ToolPolicySource;
  autoProbability: number | null;
  ruleRevision: number | null;
};

export type ToolRule = {
  providerId: ProviderId;
  instructions: string;
  revision: number;
  updatedAt: Date;
};

export function createToolPolicyStore(database: AppDatabase) {
  return {
    // Enforcement needs the current fingerprint and default, not the potentially
    // large review snapshot. Both reads stay live; only review screens need it.
    async toolPolicyDecisions(): Promise<ReadonlyMap<string, Omit<StoredToolPolicy, 'contract'>>> {
      const rows = await database
        .select({
          toolName: deploymentToolPolicies.toolName,
          fingerprint: deploymentToolPolicies.fingerprint,
          state: deploymentToolPolicies.state,
        })
        .from(deploymentToolPolicies);
      return new Map(rows.map((row) => [row.toolName, row]));
    },

    async toolPolicies(): Promise<ReadonlyMap<string, StoredToolPolicy>> {
      const rows = await database
        .select({
          toolName: deploymentToolPolicies.toolName,
          fingerprint: deploymentToolPolicies.fingerprint,
          contract: deploymentToolPolicies.contract,
          state: deploymentToolPolicies.state,
        })
        .from(deploymentToolPolicies);
      return new Map(rows.map(({ contract, ...row }) => [row.toolName, { ...row, ...(contract ? { contract } : {}) }]));
    },

    /** Who decided each of a provider's current policies, and under which rule revision. */
    async toolPolicyOrigins(providerId: ProviderId): Promise<ReadonlyMap<string, ToolPolicyOrigin>> {
      const rows = await database
        .select({
          toolName: deploymentToolPolicies.toolName,
          fingerprint: deploymentToolPolicies.fingerprint,
          source: deploymentToolPolicies.source,
          autoProbability: deploymentToolPolicies.autoProbability,
          ruleRevision: deploymentToolPolicies.ruleRevision,
        })
        .from(deploymentToolPolicies)
        .where(eq(deploymentToolPolicies.providerId, providerId));
      return new Map(rows.map(({ toolName, ...origin }) => [toolName, origin]));
    },

    /**
     * One transaction for the whole batch, including the per-user overrides it
     * invalidates. Splitting them would leave a window where a tool is blocked
     * but somebody still holds an override saying it is on.
     */
    async setToolPolicies(requests: readonly ToolPolicyWrite[]): Promise<void> {
      if (requests.length === 0) return;
      await database.transaction(async (transaction) => {
        const previousFingerprints = await currentFingerprints(transaction, requests);
        for (const request of requests) {
          const decision = { ...request, source: 'admin' as const, autoProbability: null, ruleRevision: null };
          await transaction
            .insert(deploymentToolPolicies)
            .values(decision)
            .onConflictDoUpdate({
              target: [deploymentToolPolicies.providerId, deploymentToolPolicies.toolName],
              set: {
                fingerprint: decision.fingerprint,
                contract: decision.contract,
                state: decision.state,
                source: decision.source,
                autoProbability: decision.autoProbability,
                ruleRevision: decision.ruleRevision,
                updatedByUserId: decision.updatedByUserId,
                updatedAt: new Date(),
              },
            });
          await reconcilePreferences(transaction, request, previousFingerprints.get(request.toolName));
        }
      });
    },

    /**
     * Rule-driven writes lose every race they should lose, so the conditions in
     * `pendingAutoPolicyTools` also hold when another writer got there first:
     * an existing row is only replaced if the rule wrote it, for the same
     * definition, under an older or equal rule revision. An administrator's row
     * and a row for a different definition are never touched.
     * Returns the tool names actually written.
     */
    async setAutoToolPolicies(requests: readonly AutoToolPolicyWrite[]): Promise<readonly string[]> {
      if (requests.length === 0) return [];
      return database.transaction(async (transaction) => {
        const previousFingerprints = await currentFingerprints(transaction, requests);
        const written: string[] = [];
        for (const request of requests) {
          const rows = await transaction
            .insert(deploymentToolPolicies)
            .values({ ...request, source: 'auto', updatedByUserId: null })
            .onConflictDoUpdate({
              target: [deploymentToolPolicies.providerId, deploymentToolPolicies.toolName],
              set: {
                fingerprint: request.fingerprint,
                contract: request.contract,
                state: request.state,
                source: 'auto',
                autoProbability: request.autoProbability,
                ruleRevision: request.ruleRevision,
                updatedByUserId: null,
                updatedAt: new Date(),
              },
              setWhere: sql`${deploymentToolPolicies.source} = 'auto'
                and ${deploymentToolPolicies.fingerprint} = excluded.fingerprint
                and coalesce(${deploymentToolPolicies.ruleRevision}, 0) <= excluded.rule_revision`,
            })
            .returning({ toolName: deploymentToolPolicies.toolName });
          if (rows.length === 0) continue;
          written.push(request.toolName);
          await reconcilePreferences(transaction, request, previousFingerprints.get(request.toolName));
        }
        return written;
      });
    },

    async toolRules(): Promise<ReadonlyMap<ProviderId, ToolRule>> {
      const rows = await database
        .select({
          providerId: deploymentToolRules.providerId,
          instructions: deploymentToolRules.instructions,
          revision: deploymentToolRules.revision,
          updatedAt: deploymentToolRules.updatedAt,
        })
        .from(deploymentToolRules);
      return new Map(rows.map((rule) => [rule.providerId, rule]));
    },

    async toolRule(providerId: ProviderId): Promise<ToolRule | undefined> {
      const [rule] = await database
        .select({
          providerId: deploymentToolRules.providerId,
          instructions: deploymentToolRules.instructions,
          revision: deploymentToolRules.revision,
          updatedAt: deploymentToolRules.updatedAt,
        })
        .from(deploymentToolRules)
        .where(eq(deploymentToolRules.providerId, providerId));
      return rule;
    },

    async setToolRule(request: {
      providerId: ProviderId;
      instructions: string;
      updatedByUserId: string;
    }): Promise<ToolRule> {
      const [rule] = await database
        .insert(deploymentToolRules)
        .values({ ...request, revision: 1 })
        .onConflictDoUpdate({
          target: deploymentToolRules.providerId,
          set: {
            instructions: request.instructions,
            revision: sql`${deploymentToolRules.revision} + 1`,
            updatedByUserId: request.updatedByUserId,
            updatedAt: new Date(),
          },
        })
        .returning({
          providerId: deploymentToolRules.providerId,
          instructions: deploymentToolRules.instructions,
          revision: deploymentToolRules.revision,
          updatedAt: deploymentToolRules.updatedAt,
        });
      if (!rule) throw new Error('Tool rule was not saved');
      return rule;
    },

    async clearToolRule(providerId: ProviderId): Promise<void> {
      await database.delete(deploymentToolRules).where(eq(deploymentToolRules.providerId, providerId));
    },
  };
}

async function currentFingerprints(
  transaction: AppTransaction,
  requests: readonly { toolName: string }[],
): Promise<ReadonlyMap<string, string>> {
  const rows = await transaction
    .select({
      toolName: deploymentToolPolicies.toolName,
      fingerprint: deploymentToolPolicies.fingerprint,
    })
    .from(deploymentToolPolicies)
    .where(
      inArray(
        deploymentToolPolicies.toolName,
        requests.map((request) => request.toolName),
      ),
    );
  return new Map(rows.map((row) => [row.toolName, row.fingerprint]));
}

async function reconcilePreferences(
  transaction: AppTransaction,
  policy: { toolName: string; fingerprint: string; state: ToolPolicyState },
  previousFingerprint: string | undefined,
): Promise<void> {
  const reconciliation = reconcileToolPreferences(policy, previousFingerprint);
  await transaction
    .delete(userToolPreferences)
    .where(
      reconciliation.kind === 'clear-all'
        ? eq(userToolPreferences.toolName, policy.toolName)
        : and(
            eq(userToolPreferences.toolName, policy.toolName),
            eq(userToolPreferences.isEnabled, reconciliation.isEnabled),
          ),
    );
}

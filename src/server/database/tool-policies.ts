import { and, eq, inArray } from 'drizzle-orm';
import type { ProviderId } from '../providers/types.js';
import {
  reconcileToolPreferences,
  type StoredToolPolicy,
  type ToolContractSnapshot,
  type ToolPolicyState,
} from '../tools/catalog.js';
import type { AppDatabase } from './client.js';
import { deploymentToolPolicies, userToolPreferences } from './schema.js';

type ToolPolicyWrite = {
  providerId: ProviderId;
  toolName: string;
  fingerprint: string;
  contract: ToolContractSnapshot;
  state: ToolPolicyState;
  updatedByUserId: string;
};

export function createToolPolicyStore(database: AppDatabase) {
  return {
    async toolPolicies(): Promise<ReadonlyMap<string, StoredToolPolicy>> {
      const rows = await database
        .select({
          toolName: deploymentToolPolicies.toolName,
          fingerprint: deploymentToolPolicies.fingerprint,
          contract: deploymentToolPolicies.contract,
          state: deploymentToolPolicies.state,
        })
        .from(deploymentToolPolicies);
      return new Map(rows.map(({ contract, ...row }) => [
        row.toolName,
        { ...row, ...(contract ? { contract } : {}) },
      ]));
    },

    /**
     * One transaction for the whole batch, including the per-user overrides it
     * invalidates. Splitting them would leave a window where a tool is blocked
     * but somebody still holds an override saying it is on.
     */
    async setToolPolicies(requests: readonly ToolPolicyWrite[]): Promise<void> {
      if (requests.length === 0) return;
      await database.transaction(async (transaction) => {
        const previous = await transaction
          .select({
            toolName: deploymentToolPolicies.toolName,
            fingerprint: deploymentToolPolicies.fingerprint,
          })
          .from(deploymentToolPolicies)
          .where(inArray(deploymentToolPolicies.toolName, requests.map((request) => request.toolName)));
        const previousFingerprints = new Map(previous.map((row) => [row.toolName, row.fingerprint]));

        for (const request of requests) {
          await transaction
            .insert(deploymentToolPolicies)
            .values(request)
            .onConflictDoUpdate({
              target: [deploymentToolPolicies.providerId, deploymentToolPolicies.toolName],
              set: {
                fingerprint: request.fingerprint,
                contract: request.contract,
                state: request.state,
                updatedByUserId: request.updatedByUserId,
                updatedAt: new Date(),
              },
            });

          const reconciliation = reconcileToolPreferences(request, previousFingerprints.get(request.toolName));
          await transaction
            .delete(userToolPreferences)
            .where(reconciliation.kind === 'clear-all'
              ? eq(userToolPreferences.toolName, request.toolName)
              : and(
                eq(userToolPreferences.toolName, request.toolName),
                eq(userToolPreferences.isEnabled, reconciliation.isEnabled),
              ));
        }
      });
    },
  };
}

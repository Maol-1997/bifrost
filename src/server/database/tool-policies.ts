import type { ProviderId } from '../providers/types.js';
import type { StoredToolPolicy, ToolContractSnapshot, ToolPolicyState } from '../tools/catalog.js';
import type { AppDatabase } from './client.js';
import { deploymentToolPolicies } from './schema.js';

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

    async setToolPolicies(requests: readonly ToolPolicyWrite[]): Promise<void> {
      await database.transaction(async (transaction) => {
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
        }
      });
    },
  };
}

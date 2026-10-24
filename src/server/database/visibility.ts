import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ProviderId } from '../providers/types.js';
import type { AppDatabase } from './client.js';
import { providerCredentials, userProviderPreferences, userToolPreferences } from './schema.js';

export type UserVisibilityState = {
  connectedProviders: Set<ProviderId>;
  hiddenProviders: Set<ProviderId>;
  /** Only the tools this user overrode; absence means the deployment default applies. */
  toolPreferences: ReadonlyMap<string, boolean>;
};

const visibilityRowSchema = z.object({
  connected: z.array(z.string()),
  hidden: z.array(z.string()),
  preferences: z.record(z.string(), z.boolean()),
});

export function createVisibilityStore(database: AppDatabase) {
  return {
    /**
     * Everything per-user that decides which tools an MCP request registers,
     * in one statement on one pooled connection: the same rows
     * `connectedProviders`, `hiddenProviders` and `toolPreferences` read.
     * Deployment policies are deliberately not part of it; they are global,
     * read live on every request, and stay their own query.
     */
    async userVisibilityState(userId: string): Promise<UserVisibilityState> {
      const result = await database.execute(sql`
        select
          coalesce((
            select json_agg(${providerCredentials.providerId})
            from ${providerCredentials}
            where ${providerCredentials.userId} = ${userId}
          ), '[]'::json) as "connected",
          coalesce((
            select json_agg(${userProviderPreferences.providerId})
            from ${userProviderPreferences}
            where ${userProviderPreferences.userId} = ${userId} and ${userProviderPreferences.isHidden}
          ), '[]'::json) as "hidden",
          coalesce((
            select json_object_agg(${userToolPreferences.toolName}, ${userToolPreferences.isEnabled})
            from ${userToolPreferences}
            where ${userToolPreferences.userId} = ${userId}
          ), '{}'::json) as "preferences"
      `);
      const row = visibilityRowSchema.parse(result.rows[0]);
      return {
        connectedProviders: new Set(row.connected as ProviderId[]),
        hiddenProviders: new Set(row.hidden as ProviderId[]),
        toolPreferences: new Map(Object.entries(row.preferences)),
      };
    },
  };
}

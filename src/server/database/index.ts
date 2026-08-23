import type { Config } from '../config.js';
import { createDatabaseConnection } from './client.js';
import { createConnectionStore } from './connections.js';
import { createOAuthGrantStore } from './oauth-grants.js';
import { createPreferenceStore } from './preferences.js';
import { createSessionStore } from './sessions.js';
import { createToolPolicyStore } from './tool-policies.js';
import { createUserStore } from './users.js';

/**
 * The one data-access object the rest of the server holds. Each aggregate —
 * users, sessions, OAuth grants, provider connections, preferences, tool
 * policies — lives in its own store module; spreading them here keeps the
 * surface flat, so callers depend on one object and no store leaks out.
 */
export function createDatabase(config: Config) {
  const { client, database } = createDatabaseConnection(config.DATABASE_URL);
  return {
    ...createUserStore(database),
    ...createSessionStore(database),
    ...createOAuthGrantStore(database, config),
    ...createConnectionStore(database, config),
    ...createPreferenceStore(database),
    ...createToolPolicyStore(database),
    async close(): Promise<void> {
      await client.end();
    },
  };
}

export type Database = ReturnType<typeof createDatabase>;

export { SESSION_TTL_SECONDS, type SessionRecord } from './sessions.js';
export type { StoredCredential } from './connections.js';
export type {
  OAuthGrantRecord,
  OAuthIdentity,
  OAuthTokenPair,
  RefreshOutcome,
  StoredOAuthClient,
} from './oauth-grants.js';
export type { ProviderAgentNote } from './preferences.js';

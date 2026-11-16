import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle, type NodePgDatabase, type NodePgTransaction } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { errorSummary, logger } from '../logger.js';
import * as schema from './schema.js';

const { Pool } = pg;

export type AppDatabase = NodePgDatabase<typeof schema>;
export type AppTransaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

export type DatabaseConnection = {
  client: pg.Pool;
  database: AppDatabase;
};

/** A request waiting longer than this for a connection fails instead of hanging. */
const CONNECTION_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 30_000;

export function createDatabaseConnection(connectionString: string, poolMax: number): DatabaseConnection {
  const client = new Pool({
    connectionString,
    max: poolMax,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
  });
  // An idle client dropped by the server (restart, failover) emits 'error' on
  // the pool. Unhandled, that would crash the process; the pool already
  // discards the client and the next query opens a new one.
  client.on('error', (error) => {
    logger.error(errorSummary(error), 'An idle Postgres connection failed');
  });
  return { client, database: drizzle({ client, schema }) };
}

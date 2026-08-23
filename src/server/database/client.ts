import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle, type NodePgDatabase, type NodePgTransaction } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

export type AppDatabase = NodePgDatabase<typeof schema>;
export type AppTransaction = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

export type DatabaseConnection = {
  client: pg.Pool;
  database: AppDatabase;
};

export function createDatabaseConnection(connectionString: string): DatabaseConnection {
  const client = new Pool({ connectionString });
  return { client, database: drizzle({ client, schema }) };
}

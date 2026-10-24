import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabaseConnection } from '../../src/server/database/client.js';

export type IntegrationEnvironment = { databaseUrl: string; redisUrl: string };

export function integrationEnvironment(environment: NodeJS.ProcessEnv = process.env): IntegrationEnvironment {
  const databaseUrl = environment.TEST_DATABASE_URL;
  const redisUrl = environment.TEST_REDIS_URL;
  if (!databaseUrl || !redisUrl) {
    throw new Error('Set TEST_DATABASE_URL and TEST_REDIS_URL; `npm run integration -- test` starts both on loopback');
  }
  return { databaseUrl, redisUrl };
}

/**
 * Rebuilds the schema from the committed migrations. Refuses any database whose
 * name does not say it is a test database, because the first step drops every
 * table in it.
 */
export async function resetIntegrationDatabase(databaseUrl: string): Promise<void> {
  const databaseName = new URL(databaseUrl).pathname.slice(1);
  if (!/test/i.test(databaseName)) {
    throw new Error(`Refusing to reset "${databaseName}": integration databases must have "test" in their name`);
  }
  const connection = createDatabaseConnection(databaseUrl, 1);
  try {
    await connection.database.execute(sql`drop schema if exists drizzle cascade`);
    await connection.database.execute(sql`drop schema public cascade`);
    await connection.database.execute(sql`create schema public`);
    await migrate(connection.database, { migrationsFolder: 'migrations' });
  } finally {
    await connection.client.end();
  }
}

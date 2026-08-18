import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabaseConnection } from './client.js';

const DEFAULT_DATABASE_URL = 'postgres://bifrost:bifrost@localhost:5432/bifrost';
const connection = createDatabaseConnection(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);

try {
  await migrate(connection.database, { migrationsFolder: 'migrations' });
} finally {
  await connection.client.end();
}

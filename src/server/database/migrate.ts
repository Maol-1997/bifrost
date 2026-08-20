import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { DEVELOPMENT_DATABASE_URL } from '../config.js';
import { createDatabaseConnection } from './client.js';

const connection = createDatabaseConnection(process.env.DATABASE_URL ?? DEVELOPMENT_DATABASE_URL);

try {
  await migrate(connection.database, { migrationsFolder: 'migrations' });
} finally {
  await connection.client.end();
}

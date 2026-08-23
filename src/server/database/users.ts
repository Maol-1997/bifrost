import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from './client.js';
import { users } from './schema.js';

export function createUserStore(database: AppDatabase) {
  return {
    async upsertUser(email: string, name: string): Promise<string> {
      const [row] = await database
        .insert(users)
        .values({ id: randomUUID(), email, name })
        .onConflictDoUpdate({ target: users.email, set: { name } })
        .returning({ id: users.id });
      if (!row) throw new Error('User upsert returned no row');
      return row.id;
    },

    async getUser(userId: string): Promise<{ name: string; email: string } | undefined> {
      const [row] = await database
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row;
    },

    async ensureDevelopmentUser(userId: string): Promise<void> {
      await database
        .insert(users)
        .values({ id: userId, email: `${userId}@development.invalid`, name: 'Development User' })
        .onConflictDoNothing({ target: users.id });
    },
  };
}

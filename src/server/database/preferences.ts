import { and, eq, sql } from 'drizzle-orm';
import type { ProviderId } from '../providers/types.js';
import type { AppDatabase } from './client.js';
import { userProviderAgentNotes, userProviderPreferences, userToolPreferences } from './schema.js';

export type ProviderAgentNote = {
  note: string;
  updatedAt: Date;
};

export function createPreferenceStore(database: AppDatabase) {
  return {
    async hiddenProviders(userId: string): Promise<Set<ProviderId>> {
      const rows = await database
        .select({ providerId: userProviderPreferences.providerId })
        .from(userProviderPreferences)
        .where(and(eq(userProviderPreferences.userId, userId), eq(userProviderPreferences.isHidden, true)));
      return new Set(rows.map((row) => row.providerId));
    },

    async setProviderHidden(userId: string, providerId: ProviderId, isHidden: boolean): Promise<void> {
      await database
        .insert(userProviderPreferences)
        .values({ userId, providerId, isHidden })
        .onConflictDoUpdate({
          target: [userProviderPreferences.userId, userProviderPreferences.providerId],
          set: { isHidden },
        });
    },

    async providerAgentNotes(userId: string): Promise<ReadonlyMap<ProviderId, ProviderAgentNote>> {
      const rows = await database
        .select({
          providerId: userProviderAgentNotes.providerId,
          note: userProviderAgentNotes.note,
          updatedAt: userProviderAgentNotes.updatedAt,
        })
        .from(userProviderAgentNotes)
        .where(eq(userProviderAgentNotes.userId, userId));
      return new Map(rows.map(({ providerId, ...note }) => [providerId, note]));
    },

    async setProviderAgentNote(userId: string, providerId: ProviderId, note: string): Promise<void> {
      await database
        .insert(userProviderAgentNotes)
        .values({ userId, providerId, note })
        .onConflictDoUpdate({
          target: [userProviderAgentNotes.userId, userProviderAgentNotes.providerId],
          set: { note, updatedAt: sql`now()` },
        });
    },

    async clearProviderAgentNote(userId: string, providerId: ProviderId): Promise<void> {
      await database
        .delete(userProviderAgentNotes)
        .where(and(eq(userProviderAgentNotes.userId, userId), eq(userProviderAgentNotes.providerId, providerId)));
    },

    /**
     * The tools this user has overridden. Absence means the administrator's
     * current default applies.
     */
    async toolPreferences(userId: string): Promise<ReadonlyMap<string, boolean>> {
      const rows = await database
        .select({ toolName: userToolPreferences.toolName, isEnabled: userToolPreferences.isEnabled })
        .from(userToolPreferences)
        .where(eq(userToolPreferences.userId, userId));
      return new Map(rows.map((row) => [row.toolName, row.isEnabled]));
    },

    async setToolPreference(userId: string, toolName: string, isEnabled: boolean): Promise<void> {
      await database
        .insert(userToolPreferences)
        .values({ userId, toolName, isEnabled })
        .onConflictDoUpdate({
          target: [userToolPreferences.userId, userToolPreferences.toolName],
          set: { isEnabled },
        });
    },

    async clearToolPreference(userId: string, toolName: string): Promise<void> {
      await database
        .delete(userToolPreferences)
        .where(and(eq(userToolPreferences.userId, userId), eq(userToolPreferences.toolName, toolName)));
    },
  };
}

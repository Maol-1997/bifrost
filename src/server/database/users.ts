import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppDatabase, AppTransaction } from './client.js';
import { users } from './schema.js';

const UNIQUE_VIOLATION = '23505';

/** What Google asserts about the person signing in. `googleSubject` is the `sub` claim. */
export type GoogleIdentity = {
  googleSubject: string;
  email: string;
  name: string;
};

/** The email Google asserted already belongs to an account with a different Google subject. */
export class GoogleAccountConflictError extends Error {
  constructor() {
    super('This email already belongs to another Bifrost account');
    this.name = 'GoogleAccountConflictError';
  }
}

/**
 * The four writes {@link resolveGoogleUser} chooses between, kept behind an
 * interface so the resolution order can be tested without a database.
 */
export type GoogleUserWrites = {
  updateKnownSubject: (identity: GoogleIdentity) => Promise<string | undefined>;
  linkUnclaimedEmail: (identity: GoogleIdentity) => Promise<string | undefined>;
  hasEmailOwner: (email: string) => Promise<boolean>;
  insertUser: (identity: GoogleIdentity) => Promise<string>;
};

/**
 * Resolves a Google identity to a Bifrost user id.
 *
 * The order is the security boundary. The subject is the identity, so it is
 * matched first and an email change follows it. Email only identifies an account
 * that predates subjects, and only while nobody owns it — an email that already
 * belongs to a different subject is a takeover attempt (Google reuses a deleted
 * Workspace address for a new person) and must fail rather than resolve.
 */
export async function resolveGoogleUser(writes: GoogleUserWrites, identity: GoogleIdentity): Promise<string> {
  const known = await writes.updateKnownSubject(identity);
  if (known) return known;
  const linked = await writes.linkUnclaimedEmail(identity);
  if (linked) return linked;
  if (await writes.hasEmailOwner(identity.email)) throw new GoogleAccountConflictError();
  return writes.insertUser(identity);
}

export async function resolveGoogleUserWithRetry(resolve: () => Promise<string>): Promise<string> {
  try {
    return await resolve();
  } catch (error) {
    if (!isIdentityResolutionRace(error)) throw error;
  }

  try {
    return await resolve();
  } catch (error) {
    if (isUniqueViolation(error)) throw new GoogleAccountConflictError();
    throw error;
  }
}

export function createUserStore(database: AppDatabase) {
  function resolve(identity: GoogleIdentity): Promise<string> {
    return database.transaction(async (transaction) => resolveGoogleUser(googleUserWrites(transaction), identity));
  }

  return {
    /**
     * Turns a verified Google sign-in into a user id, creating the account on
     * first sign-in and linking a pre-subject account exactly once.
     *
     * Runs in one transaction so a half-linked row can never be observed. Two
     * first sign-ins can race on either a unique index or the legacy row lock;
     * the loser retries once and then resolves by subject. A persistent conflict
     * fails the sign-in rather than guessing.
     */
    async upsertGoogleUser(identity: GoogleIdentity): Promise<string> {
      return resolveGoogleUserWithRetry(() => resolve(identity));
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

export function isUniqueViolation(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: unknown }).code === UNIQUE_VIOLATION
  );
}

function isIdentityResolutionRace(error: unknown): boolean {
  return error instanceof GoogleAccountConflictError || isUniqueViolation(error);
}

function googleUserWrites(transaction: AppTransaction): GoogleUserWrites {
  return {
    updateKnownSubject: async (identity) => {
      const [row] = await transaction
        .update(users)
        .set({ email: identity.email, name: identity.name })
        .where(eq(users.googleSubject, identity.googleSubject))
        .returning({ id: users.id });
      return row?.id;
    },

    // `google_subject is null` in the predicate is what makes the link one-time:
    // a concurrent sign-in that already claimed the row matches nothing here.
    linkUnclaimedEmail: async (identity) => {
      const [row] = await transaction
        .update(users)
        .set({ googleSubject: identity.googleSubject, name: identity.name })
        .where(and(eq(users.email, identity.email), isNull(users.googleSubject)))
        .returning({ id: users.id });
      return row?.id;
    },

    hasEmailOwner: async (email) => {
      const rows = await transaction.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      return rows.length > 0;
    },

    insertUser: async (identity) => {
      const [row] = await transaction
        .insert(users)
        .values({
          id: randomUUID(),
          googleSubject: identity.googleSubject,
          email: identity.email,
          name: identity.name,
        })
        .returning({ id: users.id });
      if (!row) throw new Error('User insert returned no row');
      return row.id;
    },
  };
}

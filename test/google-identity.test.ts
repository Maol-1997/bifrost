import { describe, expect, it, vi } from 'vitest';
import {
  GoogleAccountConflictError,
  isUniqueViolation,
  resolveGoogleUser,
  resolveGoogleUserWithRetry,
  type GoogleIdentity,
  type GoogleUserWrites,
} from '../src/server/database/users.js';
import { googleIdentityClaimsSchema } from '../src/server/oauth.js';

type UserRow = { id: string; googleSubject: string | null; email: string; name: string };

const identity: GoogleIdentity = { googleSubject: 'google-sub-1', email: 'ada@example.test', name: 'Ada' };

describe('Google identity resolution', () => {
  it('follows the subject when the account renames its email', async () => {
    const users = inMemoryUsers([
      { id: 'user-1', googleSubject: 'google-sub-1', email: 'old@example.test', name: 'Old' },
    ]);

    await expect(resolveGoogleUser(users.writes, identity)).resolves.toBe('user-1');
    expect(users.rows[0]).toEqual({
      id: 'user-1',
      googleSubject: 'google-sub-1',
      email: 'ada@example.test',
      name: 'Ada',
    });
  });

  it('links an account created before subjects were recorded', async () => {
    const users = inMemoryUsers([{ id: 'user-1', googleSubject: null, email: 'ada@example.test', name: 'Old' }]);

    await expect(resolveGoogleUser(users.writes, identity)).resolves.toBe('user-1');
    expect(users.rows[0]?.googleSubject).toBe('google-sub-1');
  });

  it('links a legacy account only once, so a later subject cannot claim the same email', async () => {
    const users = inMemoryUsers([{ id: 'user-1', googleSubject: null, email: 'ada@example.test', name: 'Old' }]);
    await resolveGoogleUser(users.writes, identity);

    await expect(
      resolveGoogleUser(users.writes, { ...identity, googleSubject: 'google-sub-2' }),
    ).rejects.toBeInstanceOf(GoogleAccountConflictError);
  });

  it('leaves the account it refused untouched', async () => {
    const owner = { id: 'user-1', googleSubject: 'google-sub-2', email: 'ada@example.test', name: 'Other' };
    const users = inMemoryUsers([{ ...owner }]);

    await expect(resolveGoogleUser(users.writes, identity)).rejects.toBeInstanceOf(GoogleAccountConflictError);
    expect(users.rows).toEqual([owner]);
  });

  it('creates an account on a first sign-in', async () => {
    const users = inMemoryUsers([]);

    await expect(resolveGoogleUser(users.writes, identity)).resolves.toBe('created-1');
    expect(users.rows).toEqual([
      { id: 'created-1', googleSubject: 'google-sub-1', email: 'ada@example.test', name: 'Ada' },
    ]);
  });
});

describe('unique violation detection', () => {
  it('recognizes the Postgres unique violation that a lost sign-in race raises', () => {
    expect(isUniqueViolation(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe(true);
  });

  it('does not treat other failures as a race', () => {
    expect([new Error('connection terminated'), { code: '23503' }, undefined].map(isUniqueViolation)).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe('concurrent Google identity resolution', () => {
  it('retries a legacy-link conflict that resolves by subject on the next transaction', async () => {
    const resolve = vi.fn().mockRejectedValueOnce(new GoogleAccountConflictError()).mockResolvedValueOnce('user-1');

    await expect(resolveGoogleUserWithRetry(resolve)).resolves.toBe('user-1');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('preserves a real account conflict after one retry', async () => {
    const resolve = vi.fn().mockRejectedValue(new GoogleAccountConflictError());

    await expect(resolveGoogleUserWithRetry(resolve)).rejects.toBeInstanceOf(GoogleAccountConflictError);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('turns a persistent unique collision into an account conflict', async () => {
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    const resolve = vi.fn().mockRejectedValue(uniqueViolation);

    await expect(resolveGoogleUserWithRetry(resolve)).rejects.toBeInstanceOf(GoogleAccountConflictError);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('does not retry unrelated database failures', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('connection terminated'));

    await expect(resolveGoogleUserWithRetry(resolve)).rejects.toThrow('connection terminated');
    expect(resolve).toHaveBeenCalledOnce();
  });
});

describe('Google identity claims', () => {
  const claims = {
    sub: 'google-sub-1',
    email: 'ada@example.test',
    name: 'Ada',
    email_verified: true,
  };

  it.each(['sub', 'email', 'name', 'email_verified'] as const)('requires %s', (claim) => {
    const incomplete = Object.fromEntries(Object.entries(claims).filter(([key]) => key !== claim));

    expect(googleIdentityClaimsSchema.safeParse(incomplete).success).toBe(false);
  });
});

/** Stands in for the transaction: same statements, same order, no database. */
function inMemoryUsers(initial: UserRow[]): { rows: UserRow[]; writes: GoogleUserWrites } {
  const rows = [...initial];
  return {
    rows,
    writes: {
      updateKnownSubject: async (input) => {
        const row = rows.find((candidate) => candidate.googleSubject === input.googleSubject);
        if (!row) return undefined;
        Object.assign(row, { email: input.email, name: input.name });
        return row.id;
      },
      linkUnclaimedEmail: async (input) => {
        const row = rows.find((candidate) => candidate.email === input.email && candidate.googleSubject === null);
        if (!row) return undefined;
        Object.assign(row, { googleSubject: input.googleSubject, name: input.name });
        return row.id;
      },
      hasEmailOwner: async (email) => rows.some((candidate) => candidate.email === email),
      insertUser: async (input) => {
        const row = { id: `created-${rows.length + 1}`, ...input };
        rows.push(row);
        return row.id;
      },
    },
  };
}

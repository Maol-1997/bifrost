import { describe, expect, it } from 'vitest';
import {
  rotateCredentials,
  type CredentialRotationRequest,
  type CredentialRotationStore,
} from '../src/server/database/credential-rotation.js';
import type { CredentialRowKey, CredentialReplacement, StoredCredentialRecord } from '../src/server/database/index.js';

type Row = CredentialRowKey & { record: StoredCredentialRecord | Error };

function row(userId: string, record: StoredCredentialRecord | Error = { accessToken: `token-${userId}`, scopes: [], version: `iv-${userId}` }): Row {
  return { userId, providerId: 'github', record };
}

/** A store over fixed rows that records every write and lets a test change a row mid-rotation. */
function fakeStore(rows: readonly Row[], hooks: { beforeReplace?: (replacement: CredentialReplacement) => boolean } = {}) {
  const writes: CredentialReplacement[] = [];
  const pages: (CredentialRowKey | undefined)[] = [];
  const store: CredentialRotationStore = {
    credentialsToReencrypt: async (after, limit) => {
      pages.push(after);
      const start = after === undefined ? 0 : rows.findIndex((candidate) => candidate.userId === after.userId) + 1;
      return rows.slice(start, start + limit).map(({ userId, providerId }) => ({ userId, providerId }));
    },
    getCredential: async (userId) => {
      const record = rows.find((candidate) => candidate.userId === userId)?.record;
      if (record instanceof Error) throw record;
      return record;
    },
    replaceCredentialIfUnchanged: async (replacement) => {
      if (hooks.beforeReplace && !hooks.beforeReplace(replacement)) return false;
      writes.push(replacement);
      return true;
    },
  };
  return { store, writes, pages };
}

const unlocked: CredentialRotationRequest['withRowLock'] = async (_row, operation) => operation();

describe('credential key rotation', () => {
  it('only reads in a dry run and reports what it would rewrite', async () => {
    const { store, writes } = fakeStore([row('a'), row('b')]);

    const report = await rotateCredentials({ store, withRowLock: unlocked, apply: false, batchSize: 10 });

    expect({ report, writes }).toEqual({
      report: { apply: false, pending: 2, readable: 2, reencrypted: 0, changedConcurrently: 0, busy: 0, failed: [] },
      writes: [],
    });
  });

  it('rewrites each row through the version-checked replace with exactly what it read', async () => {
    const { store, writes } = fakeStore([row('a')]);

    const report = await rotateCredentials({ store, withRowLock: unlocked, apply: true, batchSize: 10 });

    expect({ reencrypted: report.reencrypted, writes }).toEqual({
      reencrypted: 1,
      writes: [{ userId: 'a', providerId: 'github', credential: { accessToken: 'token-a', scopes: [] }, expectedVersion: 'iv-a' }],
    });
  });

  it('leaves a row alone when a refresh replaced it between read and write', async () => {
    const { store, writes } = fakeStore([row('a'), row('b')], { beforeReplace: (replacement) => replacement.userId !== 'a' });

    const report = await rotateCredentials({ store, withRowLock: unlocked, apply: true, batchSize: 10 });

    expect({ reencrypted: report.reencrypted, changed: report.changedConcurrently, written: writes.map((write) => write.userId) })
      .toEqual({ reencrypted: 1, changed: 1, written: ['b'] });
  });

  it('counts a row removed after it was listed as changed concurrently', async () => {
    const { store } = fakeStore([row('a')]);
    store.getCredential = async () => undefined;

    const report = await rotateCredentials({ store, withRowLock: unlocked, apply: true, batchSize: 10 });

    expect(report.changedConcurrently).toBe(1);
  });

  it('skips, without reading, a row whose refresh lock is held', async () => {
    const { store, writes } = fakeStore([row('a'), row('b')]);
    const reads: string[] = [];
    const read = store.getCredential;
    store.getCredential = async (userId, providerId) => { reads.push(userId); return read(userId, providerId); };

    const report = await rotateCredentials({
      store,
      withRowLock: async (lockedRow, operation) => {
        if (lockedRow.userId === 'a') throw new Error('Credential refresh already in progress; retry shortly');
        return operation();
      },
      apply: true,
      batchSize: 10,
    });

    expect({ busy: report.busy, reads, written: writes.map((write) => write.userId) })
      .toEqual({ busy: 1, reads: ['b'], written: ['b'] });
  });

  it('reports rows no configured key can open and keeps going', async () => {
    const { store, writes } = fakeStore([row('a', new Error('Unknown encryption key id: gone')), row('b')]);

    const report = await rotateCredentials({ store, withRowLock: unlocked, apply: true, batchSize: 10 });

    expect({ failed: report.failed, written: writes.map((write) => write.userId) }).toEqual({
      failed: [{ userId: 'a', providerId: 'github', reason: 'Unknown encryption key id: gone' }],
      written: ['b'],
    });
  });

  it('pages through every row in key order', async () => {
    const { store, pages } = fakeStore([row('a'), row('b'), row('c'), row('d'), row('e')]);

    const report = await rotateCredentials({ store, withRowLock: unlocked, apply: true, batchSize: 2 });

    expect({ reencrypted: report.reencrypted, pages: pages.map((page) => page?.userId) })
      .toEqual({ reencrypted: 5, pages: [undefined, 'b', 'd'] });
  });
});

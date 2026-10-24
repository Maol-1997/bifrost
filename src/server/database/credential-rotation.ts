import type { CredentialRowKey, Database } from './index.js';

export type CredentialRotationStore = Pick<Database, 'credentialsToReencrypt' | 'getCredential' | 'replaceCredentialIfUnchanged'>;

export type CredentialRotationRequest = {
  store: CredentialRotationStore;
  /** Must be the lock a provider refresh holds for the same row. */
  withRowLock: <T>(row: CredentialRowKey, operation: () => Promise<T>) => Promise<T>;
  apply: boolean;
  batchSize: number;
};

export type CredentialRotationReport = {
  apply: boolean;
  /** Rows found under a retired key or format. */
  pending: number;
  /** Dry run only: decrypted successfully and would be rewritten. */
  readable: number;
  reencrypted: number;
  /** Rewritten or removed by someone else between read and write. That writer already used the active key. */
  changedConcurrently: number;
  /** A refresh held the row's lock. The row is untouched; run again to finish it. */
  busy: number;
  failed: readonly (CredentialRowKey & { reason: string })[];
};

/**
 * Re-seals every credential not yet under the active key, one row at a time,
 * while the service keeps running. Each row is read and rewritten under the
 * refresh lock and through the same version-checked UPDATE a refresh uses, so
 * neither can undo the other. Rows that cannot be decrypted are reported, not
 * skipped silently: they are credentials no key in the keyring can open.
 */
export async function rotateCredentials(request: CredentialRotationRequest): Promise<CredentialRotationReport> {
  const report = { apply: request.apply, pending: 0, readable: 0, reencrypted: 0, changedConcurrently: 0, busy: 0 };
  const failed: (CredentialRowKey & { reason: string })[] = [];
  let after: CredentialRowKey | undefined;
  for (;;) {
    const rows = await request.store.credentialsToReencrypt(after, request.batchSize);
    for (const row of rows) {
      report.pending += 1;
      const outcome = await rotateRow(request, row);
      if (outcome.kind === 'failed') failed.push({ ...row, reason: outcome.reason });
      else report[outcome.kind] += 1;
    }
    if (rows.length < request.batchSize) break;
    after = rows.at(-1);
  }
  return { ...report, failed };
}

type RowOutcome =
  | { kind: 'readable' | 'reencrypted' | 'changedConcurrently' | 'busy' }
  | { kind: 'failed'; reason: string };

async function rotateRow(request: CredentialRotationRequest, row: CredentialRowKey): Promise<RowOutcome> {
  try {
    return await request.withRowLock(row, async () => {
      // Failures inside the lock are about this row's contents; anything that
      // escapes the lock itself means it could not be taken, so nothing was read.
      try {
        return await reencryptRow(request, row);
      } catch (error) {
        return { kind: 'failed', reason: error instanceof Error ? error.message : 'Unknown error' };
      }
    });
  } catch {
    return { kind: 'busy' };
  }
}

async function reencryptRow(request: CredentialRotationRequest, row: CredentialRowKey): Promise<RowOutcome> {
  const current = await request.store.getCredential(row.userId, row.providerId);
  if (!current) return { kind: 'changedConcurrently' };
  if (!request.apply) return { kind: 'readable' };
  const { version, ...credential } = current;
  const replaced = await request.store.replaceCredentialIfUnchanged({
    userId: row.userId, providerId: row.providerId, credential, expectedVersion: version,
  });
  return { kind: replaced ? 'reencrypted' : 'changedConcurrently' };
}

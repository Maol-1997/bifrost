import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { Coordinator } from '../coordination.js';
import { logger } from '../logger.js';
import { providerRefreshLockKey } from '../oauth.js';
import { RedisRuntime } from '../redis.js';
import { rotateCredentials } from './credential-rotation.js';
import { createDatabase } from './index.js';

const { values: options } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    'batch-size': { type: 'string', default: '100' },
  },
});
const batchSize = Number(options['batch-size']);
if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('--batch-size must be a positive integer');

const config = loadConfig();
// Only a shared Redis lock excludes refreshes running in the live servers.
const redis = await RedisRuntime.connect({
  required: config.NODE_ENV === 'production',
  ...(config.REDIS_URL ? { url: config.REDIS_URL } : {}),
});
if (!redis && options.apply) {
  logger.warn(
    {},
    'No Redis: rotation cannot hold the refresh lock of other processes; only the version check protects concurrent refreshes',
  );
}
const coordinator = new Coordinator(redis?.commands);
const database = createDatabase(config);

try {
  logger.info(
    { activeKeyId: config.encryptionKeyring.activeKeyId, usage: await database.credentialKeyUsage() },
    'Credential keys before rotation',
  );
  const report = await rotateCredentials({
    store: database,
    withRowLock: (row, operation) =>
      coordinator.withLock(providerRefreshLockKey(row.userId, row.providerId), operation),
    apply: options.apply,
    batchSize,
  });
  for (const failure of report.failed)
    logger.error(failure, 'Credential could not be decrypted with any configured key');
  const { failed, ...counts } = report;
  logger.info(
    { ...counts, failed: failed.length },
    options.apply ? 'Credential rotation finished' : 'Dry run finished; pass --apply to re-encrypt',
  );
  if (options.apply) logger.info({ usage: await database.credentialKeyUsage() }, 'Credential keys after rotation');
  if (failed.length > 0 || report.busy > 0) process.exitCode = 1;
} finally {
  await database.close();
  await redis?.close();
}

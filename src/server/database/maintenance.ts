import { errorSummary, logger } from '../logger.js';
import type { ExpiredAuthStateCounts } from './index.js';

const SWEEP_INTERVAL_MS = 3_600_000;
const SWEEP_LOCK_KEY = 'bifrost:v1:maintenance:database';

export type DatabaseMaintenanceOptions = {
  deleteExpiredAuthState: () => Promise<ExpiredAuthStateCounts>;
  /**
   * Cross-worker mutual exclusion. Anything with these semantics fits — the
   * scheduler must not know whether the lock is Redis, Postgres or in-process.
   */
  withLock: <T>(key: string, operation: () => Promise<T>) => Promise<T>;
  intervalMs?: number;
};

/**
 * Sweeps lapsed sessions and OAuth tokens, and dynamically registered OAuth
 * clients that never got a grant, on a timer.
 *
 * Expiry is already enforced on every read, so this only bounds table growth.
 * That is why every failure here is logged and dropped: a sweep that cannot run
 * costs disk, while a sweep that can take the process down costs availability.
 */
export class DatabaseMaintenance {
  private timer: NodeJS.Timeout | undefined;
  private sweep: Promise<void> | undefined;
  private isSweeping = false;

  constructor(private readonly options: DatabaseMaintenanceOptions) {}

  /** Sweeps once immediately, so a deploy after a long outage does not wait an hour. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.startSweep(), this.options.intervalMs ?? SWEEP_INTERVAL_MS);
    // The sweep must never be the reason the process stays alive.
    this.timer.unref();
    this.startSweep();
  }

  /** Resolves once the in-flight sweep has finished, so shutdown never cancels a delete mid-flight. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.sweep;
  }

  private startSweep(): void {
    // A sweep slower than the interval must not stack up behind itself.
    if (this.isSweeping) return;
    this.isSweeping = true;
    this.sweep = this.sweepOnce().finally(() => {
      this.isSweeping = false;
    });
  }

  private async sweepOnce(): Promise<void> {
    try {
      const counts = await this.options.withLock(SWEEP_LOCK_KEY, this.options.deleteExpiredAuthState);
      const deleted = counts.sessions + counts.accessTokens + counts.refreshTokens + counts.unusedClients;
      if (deleted === 0) logger.debug(counts, 'Nothing expired to sweep');
      else logger.info(counts, 'Deleted expired sessions, OAuth tokens and unused OAuth clients');
    } catch (error) {
      // Includes another worker already holding the lock: whoever holds it is
      // doing the work, and this worker simply tries again next interval.
      logger.warn(errorSummary(error), 'Could not sweep expired sessions and OAuth tokens');
    }
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseMaintenance } from '../src/server/database/maintenance.js';

const INTERVAL_MS = 60_000;
const NOTHING_EXPIRED = { sessions: 0, accessTokens: 0, refreshTokens: 0, unusedClients: 0 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('expired authentication state sweeps', () => {
  it('sweeps once immediately rather than waiting for the first interval', async () => {
    const maintenance = createMaintenance();
    maintenance.scheduler.start();
    await maintenance.settle();

    expect(maintenance.deleteExpiredAuthState).toHaveBeenCalledOnce();
    await maintenance.scheduler.close();
  });

  it('holds the shared lock, so only one worker sweeps', async () => {
    const maintenance = createMaintenance();
    maintenance.scheduler.start();
    await maintenance.settle();

    expect(maintenance.lockKeys).toEqual(['bifrost:v1:maintenance:database']);
    await maintenance.scheduler.close();
  });

  it('sweeps again on every interval', async () => {
    const maintenance = createMaintenance();
    maintenance.scheduler.start();
    await maintenance.advance(INTERVAL_MS * 3);

    expect(maintenance.deleteExpiredAuthState).toHaveBeenCalledTimes(4);
    await maintenance.scheduler.close();
  });

  it('keeps sweeping after a failed sweep', async () => {
    const maintenance = createMaintenance();
    maintenance.deleteExpiredAuthState.mockRejectedValueOnce(new Error('lock is held elsewhere'));
    maintenance.scheduler.start();
    await maintenance.advance(INTERVAL_MS);

    expect(maintenance.deleteExpiredAuthState).toHaveBeenCalledTimes(2);
    await maintenance.scheduler.close();
  });

  it('does not stack sweeps when one outruns the interval', async () => {
    const maintenance = createMaintenance();
    const pending = deferred();
    maintenance.deleteExpiredAuthState.mockReturnValueOnce(pending.promise);
    maintenance.scheduler.start();
    await maintenance.advance(INTERVAL_MS * 2);

    expect(maintenance.deleteExpiredAuthState).toHaveBeenCalledOnce();
    pending.resolve(NOTHING_EXPIRED);
    await maintenance.scheduler.close();
  });

  it('waits for the in-flight sweep before it closes', async () => {
    const maintenance = createMaintenance();
    const pending = deferred();
    maintenance.deleteExpiredAuthState.mockReturnValueOnce(pending.promise);
    maintenance.scheduler.start();
    await maintenance.settle();
    let closed = false;
    const closing = maintenance.scheduler.close().then(() => {
      closed = true;
    });

    await maintenance.settle();
    expect(closed).toBe(false);
    pending.resolve(NOTHING_EXPIRED);
    await closing;
  });

  it('stops sweeping once closed', async () => {
    const maintenance = createMaintenance();
    maintenance.scheduler.start();
    await maintenance.settle();
    await maintenance.scheduler.close();
    await maintenance.advance(INTERVAL_MS * 2);

    expect(maintenance.deleteExpiredAuthState).toHaveBeenCalledOnce();
  });
});

function createMaintenance() {
  vi.useFakeTimers();
  const deleteExpiredAuthState = vi.fn(async () => NOTHING_EXPIRED);
  const lockKeys: string[] = [];
  const scheduler = new DatabaseMaintenance({
    deleteExpiredAuthState,
    withLock: async (key, operation) => {
      lockKeys.push(key);
      return operation();
    },
    intervalMs: INTERVAL_MS,
  });
  const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };
  return {
    deleteExpiredAuthState,
    lockKeys,
    scheduler,
    settle,
    advance: async (milliseconds: number): Promise<void> => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    },
  };
}

function deferred() {
  let resolve: (counts: typeof NOTHING_EXPIRED) => void = () => undefined;
  const promise = new Promise<typeof NOTHING_EXPIRED>((settle) => {
    resolve = settle;
  });
  return {
    promise,
    resolve: (counts: typeof NOTHING_EXPIRED): void => {
      resolve(counts);
    },
  };
}

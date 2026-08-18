import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Coordinator } from '../src/coordination.js';
import { AgentFacingError } from '../src/errors.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('in-process concurrency leases', () => {
  it('rejects the call that would exceed the limit', async () => {
    const coordinator = new Coordinator();
    const gate = deferred();
    const first = coordinator.withConcurrencyLease('github', 1, () => gate.promise);
    await expect(coordinator.withConcurrencyLease('github', 1, () => Promise.resolve())).rejects.toBeInstanceOf(AgentFacingError);
    gate.resolve();
    await first;
  });

  it('frees exactly one slot per completed lease, whatever order they finish in', async () => {
    const coordinator = new Coordinator();
    const gates = [deferred(), deferred(), deferred(), deferred()] as const;
    const first = coordinator.withConcurrencyLease('github', 2, () => gates[0].promise);
    const second = coordinator.withConcurrencyLease('github', 2, () => gates[1].promise);
    gates[1].resolve();
    await second;
    const third = coordinator.withConcurrencyLease('github', 2, () => gates[2].promise);
    // First finishes while third is still running. Restoring the count first
    // captured at entry (0) would forget third entirely and admit two more.
    gates[0].resolve();
    await first;
    const fourth = coordinator.withConcurrencyLease('github', 2, () => gates[3].promise);
    await expect(coordinator.withConcurrencyLease('github', 2, () => Promise.resolve())).rejects.toBeInstanceOf(AgentFacingError);
    gates[2].resolve();
    gates[3].resolve();
    await Promise.all([third, fourth]);
  });

  it('releases the slot when the operation throws', async () => {
    const coordinator = new Coordinator();
    await expect(coordinator.withConcurrencyLease('github', 1, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(coordinator.withConcurrencyLease('github', 1, () => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});

describe('in-process ephemeral values', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('hands a value back exactly once', async () => {
    const coordinator = new Coordinator();
    await coordinator.setEphemeral('k', 'v', 60);
    expect(await coordinator.takeEphemeral('k')).toBe('v');
    expect(await coordinator.takeEphemeral('k')).toBeUndefined();
  });

  it('treats an expired value as absent', async () => {
    const coordinator = new Coordinator();
    await coordinator.setEphemeral('k', 'v', 60);
    vi.advanceTimersByTime(60_001);
    expect(await coordinator.takeEphemeral('k')).toBeUndefined();
  });

  it('sweeps abandoned expired values instead of keeping them forever', async () => {
    const coordinator = new Coordinator();
    for (let index = 0; index < 100; index += 1) await coordinator.setEphemeral(`abandoned-${index}`, 'v', 60);
    vi.advanceTimersByTime(60_001);
    await coordinator.setEphemeral('fresh', 'v', 60);
    const store = (coordinator as unknown as { localEphemeral: Map<string, unknown> }).localEphemeral;
    expect(store.size).toBe(1);
  });
});

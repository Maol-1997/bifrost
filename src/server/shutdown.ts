import type { ServerType } from '@hono/node-server';
import { logger } from './logger.js';

/**
 * How long in-flight requests get to finish once a shutdown starts. Shorter
 * than the usual 30-second grace period before an orchestrator kills the
 * process, so the dependencies still close cleanly afterwards.
 */
export const SHUTDOWN_DEADLINE_MS = 10_000;

type ShutdownDependency = {
  name: string;
  close: () => Promise<void>;
};

export async function shutdownServer(request: {
  server: ServerType;
  dependencies: readonly ShutdownDependency[];
  deadlineMs: number;
}): Promise<void> {
  const failures: { name: string; error: unknown }[] = [];

  try {
    await drainHttpServer(request.server, request.deadlineMs);
  } catch (error) {
    failures.push({ name: 'HTTP server', error });
  }

  for (const dependency of request.dependencies) {
    try {
      await dependency.close();
    } catch (error) {
      failures.push({ name: dependency.name, error });
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `Shutdown failed: ${failures.map(({ name }) => name).join(', ')}`,
    );
  }
}

/**
 * Stops accepting connections and lets requests in flight finish. Idle
 * keep-alive connections are closed at once, since `close()` alone waits for
 * them; whatever is still open at the deadline is cut.
 */
function drainHttpServer(server: ServerType, deadlineMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      logger.warn({ deadlineMs }, 'Closing HTTP connections still open at the shutdown deadline');
      if ('closeAllConnections' in server) server.closeAllConnections();
    }, deadlineMs);
    deadline.unref();
    server.close((error) => {
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve();
    });
    if ('closeIdleConnections' in server) server.closeIdleConnections();
  });
}

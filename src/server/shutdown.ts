import type { ServerType } from '@hono/node-server';

type ShutdownDependency = {
  name: string;
  close: () => Promise<void>;
};

export async function shutdownServer(request: {
  server: ServerType;
  dependencies: readonly ShutdownDependency[];
}): Promise<void> {
  const failures: { name: string; error: unknown }[] = [];

  try {
    await drainHttpServer(request.server);
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

function drainHttpServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { APP_ROUTES } from '../../features/utils/routes.js';
import type { AppEnv } from './context.js';

const CLIENT_DIRECTORY = path.resolve(process.cwd(), 'dist/client');
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const FRONTEND_ROUTES = [
  '/',
  APP_ROUTES.signIn,
  APP_ROUTES.connectionResult,
  APP_ROUTES.integrations,
  APP_ROUTES.agents,
  APP_ROUTES.addAgent,
  APP_ROUTES.serviceStatus,
  APP_ROUTES.accountSecurity,
] as const;

export function createStaticRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const serveAsset = serveStatic<AppEnv>({
    root: CLIENT_DIRECTORY,
    onFound: (_path, context) => context.header('Cache-Control', IMMUTABLE_CACHE_CONTROL),
  });
  const assetNotFound = (context: Parameters<typeof serveAsset>[0]) => context.json({ error: 'Not found' }, 404);

  routes.get('/assets/*', serveAsset, assetNotFound);
  routes.get('/favicon.svg', serveAsset, assetNotFound);

  const serveIndex = serveStatic<AppEnv>({
    root: CLIENT_DIRECTORY,
    path: 'index.html',
    onFound: (_path, context) => context.header('Cache-Control', 'no-cache'),
  });
  const frontendUnavailable = (context: Parameters<typeof serveIndex>[0]) => context.json(
    { error: 'Frontend bundle is unavailable. Run npm run build.' },
    503,
  );

  for (const route of FRONTEND_ROUTES) routes.get(route, serveIndex, frontendUnavailable);
  routes.get(`${APP_ROUTES.integrations}/*`, serveIndex, frontendUnavailable);
  return routes;
}

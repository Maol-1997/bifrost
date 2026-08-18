import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { APP_ROUTES } from '../lib/routes.js';
import { json, sendFile } from './respond.js';

const CLIENT_DIRECTORY = path.resolve(process.cwd(), 'dist/client');

const FRONTEND_ROUTES = new Set([
  '/',
  APP_ROUTES.signIn,
  APP_ROUTES.connectionResult,
  APP_ROUTES.integrations,
  APP_ROUTES.agents,
  APP_ROUTES.addAgent,
  APP_ROUTES.serviceStatus,
  APP_ROUTES.accountSecurity,
]);

export function isFrontendRoute(pathname: string): boolean {
  return FRONTEND_ROUTES.has(pathname) || pathname.startsWith(`${APP_ROUTES.integrations}/`);
}

export async function serveClientIndex(response: ServerResponse): Promise<void> {
  try {
    const body = await readFile(path.join(CLIENT_DIRECTORY, 'index.html'));
    sendFile(response, { status: 200, contentType: 'text/html; charset=utf-8', body });
  } catch {
    json(response, 503, { error: 'Frontend bundle is unavailable. Run npm run build.' });
  }
}

export async function serveClientAsset(pathname: string, response: ServerResponse): Promise<void> {
  const relativePath = pathname.slice(1);
  const assetPath = path.resolve(CLIENT_DIRECTORY, relativePath);
  if (!assetPath.startsWith(`${CLIENT_DIRECTORY}${path.sep}`)) return json(response, 404, { error: 'Not found' });
  try {
    const body = await readFile(assetPath);
    sendFile(response, { status: 200, contentType: contentType(assetPath), body });
  } catch {
    json(response, 404, { error: 'Not found' });
  }
}

function contentType(assetPath: string): string {
  if (assetPath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (assetPath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (assetPath.endsWith('.svg')) return 'image/svg+xml';
  if (assetPath.endsWith('.png')) return 'image/png';
  if (assetPath.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

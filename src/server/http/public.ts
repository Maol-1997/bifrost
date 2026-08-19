import { Hono } from 'hono';
import { z } from 'zod';
import { APP_ROUTES } from '../../features/utils/routes.js';
import { EmailNotAllowedError } from '../oauth.js';
import { PROVIDER_REGISTRY } from '../providers/registry.js';
import type { ProviderMount } from '../providers/types.js';
import { isAccessRestricted } from '../security/access.js';
import { readAppHealth } from '../status/upstream.js';
import { setSessionCookie } from './auth.js';
import type { AppContext, AppEnv } from './context.js';
import { createStaticRoutes } from './static.js';

export function createPublicRoutes() {
  const routes = new Hono<AppEnv>();

  return routes
    .get('/healthz', (context) => context.json({ status: 'ok' }))
    .get('/api/status.json', (context) => context.json(providerStatus(context.get('dependencies').mounts)))
    .get('/api/provider-health.json', async (context) => context.json(await readAppHealth()))
    .get('/api/sign-in-policy.json', (context) => {
      const { accessPolicy } = context.get('dependencies').config;
      return context.json({
        allowedDomains: [...accessPolicy.allowedEmailDomains],
        isRestricted: isAccessRestricted(accessPolicy),
      });
    })
    .get('/auth/google/start', async (context) => {
      const location = await context.get('dependencies').oauth.startGoogleAuthorization('/');
      return context.redirect(location);
    })
    .get('/auth/google/callback', finishGoogle)
    .route('/', createStaticRoutes());
}

async function finishGoogle(context: AppContext): Promise<Response> {
  const parameters = callbackParameters(new URL(context.req.url));
  try {
    const result = await context.get('dependencies').oauth.finishGoogle(parameters.code, parameters.state);
    setSessionCookie(context, result.sessionToken);
    // Returning to the interrupted authorization request lets an agent's
    // connection flow resume after the browser sign-in step.
    return context.redirect(result.returnTo);
  } catch (error) {
    if (error instanceof EmailNotAllowedError) return context.redirect(`${APP_ROUTES.signIn}?denied=true`);
    throw error;
  }
}

export function callbackParameters(url: URL): { code: string; state: string } {
  const error = url.searchParams.get('error');
  if (error) throw new Error('OAuth authorization was denied or failed');
  return z.object({ code: z.string().min(1), state: z.string().min(1) }).parse({
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
  });
}

function providerStatus(mounts: readonly ProviderMount[]) {
  return {
    providers: PROVIDER_REGISTRY.map((provider) => {
      const mount = mounts.find((entry) => entry.providerId === provider.id);
      return {
        id: provider.id,
        name: provider.displayName,
        isMounted: mount?.isMounted ?? false,
        ...(mount?.error ? { error: mount.error } : {}),
      };
    }),
  };
}

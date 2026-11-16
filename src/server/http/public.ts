import { Hono } from 'hono';
import { z } from 'zod';
import { APP_ROUTES } from '../../features/utils/routes.js';
import { GoogleAccountConflictError } from '../database/users.js';
import { EmailNotAllowedError } from '../oauth.js';
import { PROVIDER_REGISTRY } from '../providers/registry.js';
import type { ProviderMount } from '../providers/types.js';
import { isAccessRestricted } from '../security/access.js';
import { readAppHealth } from '../status/upstream.js';
import {
  clearGoogleOAuthNonceCookie,
  readGoogleOAuthNonceCookie,
  setGoogleOAuthNonceCookie,
  setSessionCookie,
} from './auth.js';
import type { AppContext, AppEnv } from './context.js';
import { rateLimitByAddress } from './rate-limit.js';
import { createStaticRoutes } from './static.js';

export function createPublicRoutes() {
  const routes = new Hono<AppEnv>();

  return routes
    .get('/healthz', (context) => {
      const { config, redis } = context.get('dependencies');
      if (config.REDIS_URL && !redis?.isReady) return context.json({ status: 'unavailable' }, 503);
      return context.json({ status: 'ok' });
    })
    .get('/api/status.json', (context) => context.json(providerStatus(context.get('dependencies').mounts)))
    .get('/api/provider-health.json', async (context) => context.json(await readAppHealth()))
    .get('/api/sign-in-policy.json', (context) => {
      const { accessPolicy } = context.get('dependencies').config;
      return context.json({
        allowedDomains: [...accessPolicy.allowedEmailDomains],
        isRestricted: isAccessRestricted(accessPolicy),
      });
    })
    .get('/auth/google/start', rateLimitByAddress('googleSignInStart', 'browser'), async (context) => {
      const authorization = await context.get('dependencies').oauth.startGoogleAuthorization('/');
      setGoogleOAuthNonceCookie(context, authorization);
      return context.redirect(authorization.location);
    })
    .get('/auth/google/callback', finishGoogle)
    .route('/', createStaticRoutes());
}

async function finishGoogle(context: AppContext): Promise<Response> {
  let returnTo: string;
  try {
    const parameters = callbackParameters(new URL(context.req.url));
    const result = await context
      .get('dependencies')
      .oauth.finishGoogle(parameters.code, parameters.state, readGoogleOAuthNonceCookie(context));
    setSessionCookie(context, result.sessionToken);
    returnTo = result.returnTo;
  } catch (error) {
    if (error instanceof EmailNotAllowedError) returnTo = `${APP_ROUTES.signIn}?denied=true`;
    else if (error instanceof GoogleAccountConflictError) returnTo = `${APP_ROUTES.signIn}?conflict=true`;
    else throw error;
  } finally {
    clearGoogleOAuthNonceCookie(context);
  }
  return context.redirect(returnTo);
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

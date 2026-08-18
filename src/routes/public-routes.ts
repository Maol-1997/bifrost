import { z } from 'zod';
import type { RequestContext } from '../http/context.js';
import { json, redirect, sessionCookie } from '../http/respond.js';
import { isFrontendRoute, serveClientAsset, serveClientIndex } from '../http/static.js';
import { APP_ROUTES } from '../lib/routes.js';
import { EmailNotAllowedError } from '../oauth.js';
import { PROVIDER_REGISTRY } from '../providers/registry.js';
import type { ProviderMount } from '../providers/types.js';
import { isAccessRestricted } from '../security/access.js';
import { readAppHealth } from '../status/upstream.js';

/** Everything served before, or without, any authentication. Returns false when the path is not one of these. */
export async function handlePublicRoutes({ request, response, url, deps }: RequestContext): Promise<boolean> {
  if (url.pathname === '/healthz') {
    json(response, 200, { status: 'ok' });
    return true;
  }
  // Vite emits `public/` at the bundle root, not under /assets, and browsers
  // request the favicon before any authentication happens.
  if (url.pathname.startsWith('/assets/') || url.pathname === '/favicon.svg') {
    await serveClientAsset(url.pathname, response);
    return true;
  }
  if (url.pathname === '/api/status.json') {
    json(response, 200, providerStatus(deps.mounts));
    return true;
  }
  // Unauthenticated on purpose. This is the vendors' own public uptime data,
  // identical for every visitor, and it is the one screen a user needs when
  // they cannot sign in. The 60s single-flight cache — not an auth check — is
  // what stops this from amplifying traffic onto the upstream status pages.
  if (url.pathname === '/api/provider-health.json') {
    json(response, 200, await readAppHealth());
    return true;
  }
  // Public: the sign-in screen has to state the real rule before you try to log
  // in. Only the domains are published — the individual allowlist names people.
  if (url.pathname === '/api/sign-in-policy.json') {
    json(response, 200, {
      allowedDomains: [...deps.config.accessPolicy.allowedEmailDomains],
      isRestricted: isAccessRestricted(deps.config.accessPolicy),
    });
    return true;
  }
  if (url.pathname === '/auth/google/start') {
    redirect(response, await deps.oauth.startGoogleAuthorization('/'));
    return true;
  }
  if (url.pathname === '/auth/google/callback') {
    await finishGoogle({ request, response, url, deps });
    return true;
  }
  if (isFrontendRoute(url.pathname)) {
    await serveClientIndex(response);
    return true;
  }
  return false;
}

async function finishGoogle({ response, url, deps }: RequestContext): Promise<void> {
  const parameters = callbackParameters(url);
  try {
    const result = await deps.oauth.finishGoogle(parameters.code, parameters.state);
    response.setHeader('Set-Cookie', sessionCookie(result.sessionToken, deps.config));
    // Back where sign-in interrupted them. For an agent connecting, that is the
    // authorization request it was midway through, so the flow resumes instead
    // of dumping the user on the home page with no idea what to do next.
    redirect(response, result.returnTo);
  } catch (error) {
    // A disallowed account is an expected outcome, not a server fault: send it
    // to the screen that explains it instead of a 500.
    if (error instanceof EmailNotAllowedError) return redirect(response, `${APP_ROUTES.signIn}?denied=true`);
    throw error;
  }
}

export function callbackParameters(url: URL): { code: string; state: string } {
  const error = url.searchParams.get('error');
  if (error) throw new Error('OAuth authorization was denied or failed');
  return z.object({ code: z.string().min(1), state: z.string().min(1) }).parse({
    code: url.searchParams.get('code'), state: url.searchParams.get('state'),
  });
}

function providerStatus(mounts: readonly ProviderMount[]): { providers: readonly object[] } {
  return {
    providers: PROVIDER_REGISTRY.map((provider) => {
      const mount = mounts.find((entry) => entry.providerId === provider.id);
      return { id: provider.id, name: provider.displayName, isMounted: mount?.isMounted ?? false, toolCount: provider.tools.length, ...(mount?.error ? { error: mount.error } : {}) };
    }),
  };
}

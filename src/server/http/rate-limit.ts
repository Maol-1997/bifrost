import { getConnInfo } from '@hono/node-server/conninfo';
import type { MiddlewareHandler } from 'hono';
import { logger } from '../logger.js';
import type { AppContext, AppEnv } from './context.js';

const RETRY_AFTER_SECONDS = 60;

/**
 * Requests per minute for the endpoints anyone can reach before or right after
 * signing in. They create rows, mint tokens or start paid model calls, so an
 * unbounded caller costs storage, money or both.
 */
export const INBOUND_RATE_LIMITS = {
  clientRegistration: 10,
  tokenExchange: 60,
  googleSignInStart: 20,
  chatTurn: 30,
} as const;

/**
 * Per client address, shared by every worker through the coordinator. The
 * response shape follows the caller: OAuth clients read `error` and
 * `error_description`, the browser shows `error`.
 */
export function rateLimitByAddress(
  name: keyof typeof INBOUND_RATE_LIMITS,
  style: 'oauth' | 'browser',
): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const address = clientAddress(context);
    if (await isWithinLimit(context, `inbound:${name}:${address}`, INBOUND_RATE_LIMITS[name])) return next();
    logger.warn({ limit: name, address }, 'Inbound rate limit reached');
    return tooManyRequests(context, style);
  };
}

/** Per signed-in user. Must run after the browser identity is resolved. */
export function rateLimitByUser(name: keyof typeof INBOUND_RATE_LIMITS): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const { userId } = context.get('browserIdentity');
    if (await isWithinLimit(context, `inbound:${name}:${userId}`, INBOUND_RATE_LIMITS[name])) return next();
    logger.warn({ limit: name, userId }, 'Inbound rate limit reached');
    return tooManyRequests(context, 'browser');
  };
}

/**
 * The socket peer, or with TRUSTED_PROXY_HOPS = n the address the outermost of
 * n trusted proxies saw. Entries further left in X-Forwarded-For are written by
 * the caller and cannot be trusted. Without a socket (in-process test requests)
 * every caller shares one bucket, which only ever limits more.
 */
export function clientAddress(context: AppContext): string {
  const hops = context.get('dependencies').config.TRUSTED_PROXY_HOPS;
  if (hops > 0) {
    const forwarded = (context.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const address = forwarded[forwarded.length - hops];
    if (address) return address;
  }
  return socketAddress(context) ?? 'unknown';
}

function socketAddress(context: AppContext): string | undefined {
  // `app.request` in tests has no Node bindings, so there is no socket to read.
  const bindings: unknown = context.env;
  if (typeof bindings !== 'object' || bindings === null || !('incoming' in bindings || 'server' in bindings)) {
    return undefined;
  }
  return getConnInfo(context).remote.address;
}

function isWithinLimit(context: AppContext, scope: string, maximum: number): Promise<boolean> {
  return context.get('dependencies').coordinator.consumeRateLimit(scope, maximum);
}

function tooManyRequests(context: AppContext, style: 'oauth' | 'browser'): Response {
  context.header('Retry-After', String(RETRY_AFTER_SECONDS));
  return style === 'oauth'
    ? context.json({ error: 'rate_limited', error_description: 'Too many requests; retry later' }, 429)
    : context.json({ error: 'Too many requests. Try again in a minute.' }, 429);
}

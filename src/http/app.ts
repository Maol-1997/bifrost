import { hostHeaderValidation } from '@modelcontextprotocol/hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { errorSummary, logger } from '../logger.js';
import { createOAuthRoutes } from '../oauth-server/http.js';
import { createBrowserRoutes } from './browser.js';
import type { AppDependencies, AppEnv } from './context.js';
import { createMcpRoutes } from './mcp.js';
import { createPublicRoutes } from './public.js';

const contentSecurityPolicy = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  fontSrc: ['https://fonts.gstatic.com'],
  connectSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'],
  baseUri: ["'none'"],
  frameAncestors: ["'none'"],
};

export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', securityHeaders());
  app.use('*', hostHeaderValidation(allowedHostnames(dependencies.config.PUBLIC_URL)));
  app.use('*', requestId());
  app.use('*', async (context, next) => {
    context.set('dependencies', dependencies);
    await next();
  });

  app.route('/', createPublicRoutes());
  app.route('/', createOAuthRoutes());
  app.route('/', createMcpRoutes());
  app.route('/', createBrowserRoutes());

  app.notFound((context) => context.json({ error: 'Not found' }, 404));
  app.onError((error, context) => {
    if (error instanceof HTTPException) return error.getResponse();
    logger.error(errorSummary(error), 'HTTP request failed');
    return context.json({ error: 'Internal server error' }, 500);
  });
  return app;
}

export function allowedHostnames(publicUrl: string): string[] {
  return [...new Set([new URL(publicUrl).hostname, 'localhost', '127.0.0.1'])];
}

function securityHeaders(): ReturnType<typeof secureHeaders> {
  return secureHeaders({
    contentSecurityPolicy,
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    referrerPolicy: 'no-referrer',
    strictTransportSecurity: false,
    xContentTypeOptions: 'nosniff',
    xDnsPrefetchControl: false,
    xDownloadOptions: false,
    xFrameOptions: false,
    xPermittedCrossDomainPolicies: false,
    xXssProtection: false,
  });
}

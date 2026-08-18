import { randomUUID } from 'node:crypto';
import type { Next } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Config } from '../config.js';
import { logger } from '../logger.js';
import { toAuthInfo } from '../mcp.js';
import { bearerChallenge } from '../oauth-server/metadata.js';
import { authenticateAgent } from './auth.js';
import type { AppContext, AppEnv } from './context.js';
import { limitRequestBody, readJsonBody } from './request-body.js';

export function createMcpRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.all('/mcp', requireAgentIdentity, limitRequestBody, executeMcp);
  return routes;
}

async function requireAgentIdentity(context: AppContext, next: Next): Promise<Response | undefined> {
  const identity = await authenticateAgent(context);
  if (!identity) return rejectUnauthenticatedAgent(context);
  context.set('agentIdentity', identity);
  await next();
}

function rejectUnauthenticatedAgent(context: AppContext): Response {
  const { config } = context.get('dependencies');
  if (context.req.header('authorization') === undefined) return mcpMissingCredential(context, config);
  return mcpInvalidCredential(context, config);
}

async function executeMcp(context: AppContext): Promise<Response> {
  if (context.req.method !== 'POST') return context.json({ error: 'MCP requires POST' }, 405);

  const startedAt = performance.now();
  const requestId = context.req.header('x-request-id') ?? randomUUID();
  context.header('X-Request-Id', requestId);

  let parsedBody: unknown;
  try {
    parsedBody = await readJsonBody(context);
  } catch {
    return context.json({ error: 'Invalid JSON request body' }, 400);
  }
  parsedBody = attachRequestId(parsedBody, requestId);

  const { config, mcpHandler } = context.get('dependencies');
  const identity = context.get('agentIdentity');
  const response = await mcpHandler.fetch(context.req.raw, {
    authInfo: toAuthInfo(identity),
    parsedBody,
  });
  response.headers.set('X-Request-Id', requestId);
  logMcpRequest({
    body: parsedBody,
    clientId: identity.clientId,
    config,
    latencyMs: Math.round(performance.now() - startedAt),
    requestId,
    statusCode: response.status,
    userId: identity.userId,
  });
  return response;
}

function mcpMissingCredential(context: AppContext, config: Config): Response {
  context.header('WWW-Authenticate', bearerChallenge(config.PUBLIC_URL));
  return context.json({
    error: 'Authorization required. This server speaks OAuth 2.1; your MCP client can set it up for you',
  }, 401);
}

function mcpInvalidCredential(context: AppContext, config: Config): Response {
  context.header('WWW-Authenticate', bearerChallenge(config.PUBLIC_URL, 'invalid_token'));
  return context.json({ error: 'That credential is expired or not valid for this server' }, 401);
}

type McpRequestLog = {
  body: unknown;
  clientId: string;
  config: Config;
  latencyMs: number;
  requestId: string;
  statusCode: number;
  userId: string;
};

function logMcpRequest(request: McpRequestLog): void {
  const details = inspectMcpRequest(request.body);
  const fields = {
    userId: request.userId,
    clientId: request.clientId,
    jsonRpcMethod: details.method,
    ...(details.toolName ? { toolName: details.toolName } : {}),
    latencyMs: request.latencyMs,
    statusCode: request.statusCode,
    requestId: request.requestId,
  };
  if (request.latencyMs >= request.config.SLOW_REQUEST_MS) logger.warn(fields, 'Slow MCP request');
  else logger.info(fields, 'MCP request');
}

function inspectMcpRequest(body: unknown): { method: string; toolName?: string } {
  const parsed = z.object({
    method: z.string(),
    params: z.object({ name: z.string().optional() }).loose().optional(),
  }).safeParse(body);
  if (!parsed.success) return { method: 'invalid' };
  return {
    method: parsed.data.method,
    ...(parsed.data.params?.name ? { toolName: parsed.data.params.name } : {}),
  };
}

function attachRequestId(body: unknown, requestId: string): unknown {
  if (!isPlainObject(body)) return body;
  const params = body.params;
  if (!isPlainObject(params)) return body;
  const metadata = params._meta ?? {};
  if (!isPlainObject(metadata)) return body;
  return { ...body, params: { ...params, _meta: { ...metadata, requestId } } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

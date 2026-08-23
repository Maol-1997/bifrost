import type { McpHttpHandler } from '@modelcontextprotocol/server';
import type { Context } from 'hono';
import type { RequestIdVariables } from 'hono/request-id';
import type { Config } from '../config.js';
import type { Coordinator } from '../coordination.js';
import type { Database } from '../database/index.js';
import type { AgentIdentity, BrowserIdentity } from '../mcp.js';
import type { OAuthService } from '../oauth.js';
import type { ProviderMount } from '../providers/types.js';
import type { BrowserEventBus } from './events.js';

/** Everything built once at startup that a request handler may need. */
export type AppDependencies = {
  config: Config;
  database: Database;
  coordinator: Coordinator;
  oauth: OAuthService;
  mounts: readonly ProviderMount[];
  mcpHandler: McpHttpHandler;
  events: BrowserEventBus;
};

export type AppEnv = {
  Variables: RequestIdVariables & {
    dependencies: AppDependencies;
    browserIdentity: BrowserIdentity;
    agentIdentity: AgentIdentity;
  };
};

export type AppContext = Context<AppEnv>;

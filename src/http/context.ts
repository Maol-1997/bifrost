import type { McpHttpHandler } from '@modelcontextprotocol/server';
import type { Context } from 'hono';
import type { Config } from '../config.js';
import type { Coordinator } from '../coordination.js';
import type { Database } from '../db.js';
import type { HumanIdentity } from '../mcp.js';
import type { OAuthService } from '../oauth.js';
import type { ProviderMount } from '../providers/types.js';

/** Everything built once at startup that a request handler may need. */
export type AppDependencies = {
  config: Config;
  database: Database;
  coordinator: Coordinator;
  oauth: OAuthService;
  mounts: readonly ProviderMount[];
  mcpHandler: McpHttpHandler;
};

export type AppEnv = {
  Variables: {
    dependencies: AppDependencies;
    browserIdentity: HumanIdentity;
    agentIdentity: HumanIdentity;
  };
};

export type AppContext = Context<AppEnv>;

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { toNodeHandler } from '@modelcontextprotocol/node';
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
  nodeMcpHandler: ReturnType<typeof toNodeHandler>;
};

export type RequestContext = {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  deps: AppDependencies;
};

/** A request whose browser session has already been resolved. */
export type AuthenticatedContext = RequestContext & { identity: HumanIdentity };

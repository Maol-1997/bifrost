import type { InferResponseType } from 'hono/client';
import { z } from 'zod';
import { APP_ROUTES } from '@features/utils/routes';
import { isConnectableProvider, providerCatalog } from './catalog';
import { bifrostClient } from './client';
import { parseRpcResponse } from './parse-rpc-response';
import { clearPersistedQueries } from './persister';
import type { BifrostApi, ConnectionStatus } from './types';

const getStatus = bifrostClient.api['status.json'].$get;
const getConnections = bifrostClient.api['app-connections.json'].$get;
type StatusResponse = InferResponseType<typeof getStatus, 200>;
type ConnectionsResponse = InferResponseType<typeof getConnections, 200>;
const protectedResourceMetadataSchema = z.object({ resource: z.string() });
const PROTECTED_RESOURCE_ERROR = 'Bifrost address is unavailable';

function protectedResourceUrl(metadata: unknown): string | undefined {
  const result = protectedResourceMetadataSchema.safeParse(metadata);
  if (!result.success) return undefined;

  try {
    const resourceUrl = new URL(result.data.resource);
    return resourceUrl.protocol === 'https:' || resourceUrl.protocol === 'http:' ? resourceUrl.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Server facts win in this order: an unmounted provider is unavailable no
 * matter what the user connected; a connection decides between connected and
 * needs-reconnect; with neither, the provider is ready to connect.
 */
function deriveConnectionStatus(
  mount: StatusResponse['providers'][number] | undefined,
  connection: ConnectionsResponse['apps'][number] | undefined,
): ConnectionStatus {
  if (mount?.isMounted === false) return 'unavailable';
  if (connection?.isConnected) return connection.needsReconnect ? 'needs-reconnect' : 'connected';
  return 'not-connected';
}

export const liveApi: BifrostApi = {
  getProviders: async () => {
    const [status, connections] = await Promise.all([
      parseRpcResponse(getStatus()),
      parseRpcResponse(getConnections()),
    ]);
    const mountById = new Map(status.providers.map((provider) => [provider.id, provider]));
    const connectionById = new Map(connections.apps.map((connection) => [connection.providerId, connection]));
    const providers = providerCatalog.map((provider) => {
      const mount = isConnectableProvider(provider.id) ? mountById.get(provider.id) : undefined;
      const connection = isConnectableProvider(provider.id) ? connectionById.get(provider.id) : undefined;
      return {
        ...provider,
        status: deriveConnectionStatus(mount, connection),
        isHidden: connection?.isHidden ?? false,
        ...(connection?.connectedAt ? { connectedAt: connection.connectedAt } : {}),
        ...(connection?.accountLabel ? { accountLabel: connection.accountLabel } : {}),
        toolDiscoveryFailed: connection?.toolDiscoveryFailed ?? false,
        // The server owns enabled state. Re-deriving it from connection status
        // would erase the user's choices after every reload.
        tools: (connection?.tools ?? []).map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          mutability: tool.mutability,
          isEnabled: tool.isEnabled,
        })),
      };
    });
    return { data: providers, cache: connections.cache };
  },
  startProviderConnection: async (providerId) => {
    const location = bifrostClient.oauth[':providerId'].start.$url({ param: { providerId } });
    window.location.assign(location);
  },
  disconnectProvider: async (providerId) => {
    if (!isConnectableProvider(providerId)) return;
    await parseRpcResponse(
      bifrostClient.api.connections[':providerId'].disconnect.$post({
        param: { providerId },
      }),
    );
  },
  setProviderHidden: async (providerId, isHidden) => {
    if (!isConnectableProvider(providerId)) return;
    await parseRpcResponse(
      bifrostClient.api.connections[':providerId'].preference.$post({
        param: { providerId },
        json: { isHidden },
      }),
    );
  },
  // The MCP tool name is also the route key and the registered server name, so
  // there is no mapping that can drift between the switch and execution.
  setToolEnabled: async (toolName, isEnabled) => {
    await parseRpcResponse(
      bifrostClient.api.tools[':toolName'].preference.$post({
        param: { toolName },
        json: { isEnabled },
      }),
    );
  },
  getAdminProviderTools: async (providerId) => {
    const { provider, cache } = await parseRpcResponse(
      bifrostClient.api.admin.providers[':providerId']['tools.json'].$get({ param: { providerId } }),
    );
    return { data: { ...provider, providerId }, cache };
  },
  refreshAdminProviderTools: async (providerId) => {
    const { provider, cache } = await parseRpcResponse(
      bifrostClient.api.admin.providers[':providerId'].tools.refresh.$post({ param: { providerId } }),
    );
    return { data: { ...provider, providerId }, cache };
  },
  setToolPolicies: async ({ providerId, tools }) => {
    const result = await parseRpcResponse(
      bifrostClient.api.admin.tools[':providerId'].policies.$post({
        param: { providerId },
        json: { tools: [...tools] },
      }),
    );
    return result.cache;
  },
  setAutomaticToolRule: async (providerId, instructions) => {
    const result = await parseRpcResponse(
      bifrostClient.api.admin.tools[':providerId'].rule.$put({
        param: { providerId },
        json: { instructions },
      }),
    );
    return result.classification;
  },
  clearAutomaticToolRule: async (providerId) => {
    await parseRpcResponse(bifrostClient.api.admin.tools[':providerId'].rule.$delete({ param: { providerId } }));
  },
  getConnectedClients: async () => {
    const { clients } = await parseRpcResponse(bifrostClient.api['clients.json'].$get());
    return clients;
  },
  renewClient: async (client) => {
    await parseRpcResponse(
      bifrostClient.api.clients[':kind'][':id'][':action'].$post({
        param: { kind: client.kind, id: client.id, action: 'renew' },
      }),
    );
  },
  revokeClient: async (client) => {
    const result = await parseRpcResponse(
      bifrostClient.api.clients[':kind'][':id'][':action'].$post({
        param: { kind: client.kind, id: client.id, action: 'revoke' },
      }),
    );
    // Revoking the current browser kills its backing cookie immediately.
    if ('wasCurrentClient' in result && result.wasCurrentClient) {
      await clearPersistedQueries().catch(() => undefined);
      window.location.assign(APP_ROUTES.signIn);
    }
  },
  /** Reads the canonical server address, not the Vite proxy's browser origin. */
  getMcpAddress: async () => {
    const response = await fetch('/.well-known/oauth-protected-resource/mcp');
    if (!response.ok) throw new Error(`Bifrost request failed with status ${response.status}`);
    let metadata: unknown;
    try {
      metadata = await response.json();
    } catch {
      throw new Error(PROTECTED_RESOURCE_ERROR);
    }
    const resource = protectedResourceUrl(metadata);
    if (!resource) throw new Error(PROTECTED_RESOURCE_ERROR);
    return resource;
  },
};

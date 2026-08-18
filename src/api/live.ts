import { APP_ROUTES } from '@/lib/routes';
import { isConnectableProvider, providerCatalog } from './catalog';
import type { BifrostApi, ConnectedClient, ConnectionStatus, ConnectionsResponse, ProviderId, StatusResponse } from './types';

export async function fetchJson<ResponseBody>(path: string, options?: RequestInit): Promise<ResponseBody> {
  const response = await fetch(path, options);
  if (response.status === 401) {
    window.location.assign(APP_ROUTES.signIn);
    throw new Error('Authentication required');
  }
  if (!response.ok) throw new Error(`Bifrost request failed with status ${response.status}`);
  return response.json() as Promise<ResponseBody>;
}

/**
 * Server facts win in this order: an unmounted provider is unavailable no
 * matter what the user connected; a connection decides between connected and
 * needs-reconnect; with neither, only Notion (no server-side provider) is
 * unavailable rather than merely not connected.
 */
function deriveConnectionStatus(
  providerId: ProviderId,
  mount: StatusResponse['providers'][number] | undefined,
  connection: ConnectionsResponse['apps'][number] | undefined,
): ConnectionStatus {
  if (mount?.isMounted === false) return 'unavailable';
  if (connection?.isConnected) return connection.needsReconnect ? 'needs-reconnect' : 'connected';
  return providerId === 'notion' ? 'unavailable' : 'not-connected';
}

/** The real thing: every operation is a request to the Bifrost server. */
export const liveApi: BifrostApi = {
  getProviders: async () => {
    const [status, connections] = await Promise.all([
      fetchJson<StatusResponse>('/api/status.json'),
      fetchJson<ConnectionsResponse>('/api/app-connections.json'),
    ]);
    const mountById = new Map(status.providers.map((provider) => [provider.id, provider]));
    const connectionById = new Map(connections.apps.map((connection) => [connection.providerId, connection]));
    return providerCatalog.map((provider) => {
      const mount = mountById.get(provider.id);
      const connection = isConnectableProvider(provider.id) ? connectionById.get(provider.id) : undefined;
      return {
        ...provider,
        status: deriveConnectionStatus(provider.id, mount, connection),
        isHidden: connection?.isHidden ?? false,
        ...(connection?.connectedAt ? { connectedAt: connection.connectedAt } : {}),
        ...(connection?.accountLabel ? { accountLabel: connection.accountLabel } : {}),
        // Straight from the server. The enabled state is the server's answer too,
        // never re-derived from the connection status: doing that is what used to
        // wipe every choice on reload.
        tools: (connection?.tools ?? []).map((tool) => ({
          name: tool.name, title: tool.title, description: tool.description,
          mutability: tool.mutability, isEnabled: tool.isEnabled, isBlockedByServer: tool.isBlockedByServer,
        })),
      };
    });
  },
  startProviderConnection: async (providerId) => {
    window.location.assign(`/oauth/${providerId}/start`);
  },
  disconnectProvider: async (providerId) => {
    if (!isConnectableProvider(providerId)) return;
    await fetchJson(`/api/connections/${providerId}/disconnect`, { method: 'POST' });
  },
  setProviderHidden: async (providerId, isHidden) => {
    if (!isConnectableProvider(providerId)) return;
    await fetchJson(`/api/connections/${providerId}/preference`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isHidden }) });
  },
  // Keyed by the MCP tool name, which is the same string the agent calls and the
  // server registers, so there is no mapping table between what you switched
  // off and what actually stops working.
  setToolEnabled: async (toolName, isEnabled) => {
    await fetchJson(`/api/tools/${toolName}/preference`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isEnabled }),
    });
  },
  getConnectedClients: async () => {
    const { clients } = await fetchJson<{ clients: readonly ConnectedClient[] }>('/api/clients.json');
    return clients;
  },
  renewClient: async (client) => {
    await fetchJson(`/api/clients/${client.kind}/${client.id}/renew`, { method: 'POST' });
  },
  revokeClient: async (client) => {
    const { wasCurrentClient } = await fetchJson<{ wasCurrentClient: boolean }>(`/api/clients/${client.kind}/${client.id}/revoke`, { method: 'POST' });
    // Revoking the session you are browsing with is a sign-out; staying on the
    // page would show a logged-in shell backed by a dead cookie.
    if (wasCurrentClient) window.location.assign(APP_ROUTES.signIn);
  },
  /**
   * The address to give a client, read from the very document that client will
   * read to discover how to authenticate.
   *
   * Deliberately not `window.location.origin`: behind the dev proxy that is port
   * 5173, while the OAuth issuer and the audience stamped into every token are
   * the server's own `PUBLIC_URL`. Sourcing it here means the address on screen
   * cannot drift from the one the flow actually works against.
   */
  getMcpAddress: async () => {
    const { resource } = await fetchJson<{ resource: string }>('/.well-known/oauth-protected-resource/mcp');
    return resource;
  },
};

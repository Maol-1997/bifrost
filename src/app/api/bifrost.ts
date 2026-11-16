import { bifrostClient } from './client';
import { liveApi } from './live';
import { mockApi } from './mock';
import { parseRpcResponse } from './parse-rpc-response';
import type { BifrostApi, CurrentUser, HealthSnapshot, SignInPolicy } from './types';

export type * from './types';
export { getProviderCatalog, isConnectableProvider } from './catalog';

// Chosen once. Every screen talks to `api`, so production and the design
// preview cannot drift apart operation by operation.
const api: BifrostApi = import.meta.env.VITE_USE_MOCK_API === 'true' ? mockApi : liveApi;

export const getProviders = api.getProviders;
export const startProviderConnection = api.startProviderConnection;
export const disconnectProvider = api.disconnectProvider;
export const setProviderHidden = api.setProviderHidden;
export const setToolEnabled = api.setToolEnabled;
export const getAdminProviderTools = api.getAdminProviderTools;
export const refreshAdminProviderTools = api.refreshAdminProviderTools;
export const setToolPolicies = api.setToolPolicies;
export const setAutomaticToolRule = api.setAutomaticToolRule;
export const clearAutomaticToolRule = api.clearAutomaticToolRule;
export const getConnectedClients = api.getConnectedClients;
export const renewClient = api.renewClient;
export const revokeClient = api.revokeClient;
export const getMcpAddress = api.getMcpAddress;

/** Public and pre-auth, so the sign-in screen can show the rule the server enforces. */
export async function getSignInPolicy(): Promise<SignInPolicy> {
  return parseRpcResponse(bifrostClient.api['sign-in-policy.json'].$get());
}

/**
 * Deliberately does not go through `parseRpcResponse`: a 401 here must not bounce the
 * visitor to sign-in, because Service status is public and has to stay readable
 * when you cannot log in — which is exactly when you need it.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (import.meta.env.VITE_USE_MOCK_API === 'true') {
    return { name: 'Bifrost Admin', email: 'admin@example.com', isAdmin: true };
  }
  const response = await bifrostClient.api['me.json'].$get();
  if (response.status === 401) return null;
  if (response.status !== 200) throw new Error(`Bifrost request failed with status ${response.status}`);
  return response.json();
}

export async function getChatConfig(): Promise<{ configured: boolean }> {
  return parseRpcResponse(bifrostClient.api.chat['config.json'].$get());
}

export async function generateChatTitle(firstMessage: string): Promise<string> {
  const response = await parseRpcResponse(
    bifrostClient.api.chat.title.$post({
      json: { firstMessage },
    }),
  );
  return response.title;
}

/**
 * Has no mock branch: vendor uptime is public and the same for every user, and
 * this screen is only useful if it shows the real status.
 */
export async function getAppHealth(): Promise<HealthSnapshot> {
  return parseRpcResponse(bifrostClient.api['provider-health.json'].$get());
}

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
export const getConnectedClients = api.getConnectedClients;
export const renewClient = api.renewClient;
export const revokeClient = api.revokeClient;
export const getMcpAddress = api.getMcpAddress;

/** Public and pre-auth: the sign-in screen must state the real rule, not a slogan. */
export async function getSignInPolicy(): Promise<SignInPolicy> {
  return parseRpcResponse(bifrostClient.api['sign-in-policy.json'].$get());
}

/**
 * Who is signed in, or `undefined` when nobody is.
 *
 * Deliberately does not go through `parseRpcResponse`: a 401 here must not bounce the
 * visitor to sign-in, because Service status is public and has to stay readable
 * when you cannot log in — which is exactly when you need it.
 */
export async function getCurrentUser(): Promise<CurrentUser | undefined> {
  const response = await bifrostClient.api['me.json'].$get();
  if (response.status === 401) return undefined;
  if (response.status !== 200) throw new Error(`Bifrost request failed with status ${response.status}`);
  return response.json();
}

/**
 * Deliberately has no mock branch. Vendor uptime is public and identical for
 * every user, so a fake here would only ever be a lie on the one screen whose
 * entire job is telling the truth about whether GitHub is down.
 */
export async function getAppHealth(): Promise<HealthSnapshot> {
  return parseRpcResponse(bifrostClient.api['provider-health.json'].$get());
}

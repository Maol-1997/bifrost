import { queryOptions } from '@tanstack/react-query';
import { getAdminProviderTools, getConnectedClients, getProviders } from './bifrost';
import type { ProviderId } from './types';

const MAX_FRONTEND_STALE_MS = 60 * 60 * 1_000;
// Persistence silently drops queries whose gcTime is shorter than the
// persister's maxAge (24h), so the persisted query must keep pace with it.
const PERSISTED_GC_TIME_MS = 24 * 60 * 60 * 1_000;
const MIN_REFETCH_INTERVAL_MS = 1_000;
const MAX_REFETCH_JITTER_MS = 5_000;

function staleTimeFromServer(freshForMs: number | undefined): number {
  return Math.min(freshForMs ?? 0, MAX_FRONTEND_STALE_MS);
}

function nextRefetchFromServer(nextCheckInMs: number | undefined, dataUpdatedAt: number): number | false {
  if (nextCheckInMs === undefined) return false;
  const jitterMs = dataUpdatedAt % (MAX_REFETCH_JITTER_MS + 1);
  return Math.max(MIN_REFETCH_INTERVAL_MS, nextCheckInMs + jitterMs);
}

export const providersQueryOptions = queryOptions({
  queryKey: ['providers'],
  queryFn: getProviders,
  gcTime: PERSISTED_GC_TIME_MS,
  staleTime: (query) => staleTimeFromServer(query.state.data?.cache.freshForMs),
  refetchInterval: (query) => nextRefetchFromServer(
    query.state.data?.cache.nextCheckInMs,
    query.state.dataUpdatedAt,
  ),
});

export const connectedClientsQueryOptions = queryOptions({
  queryKey: ['connected-clients'],
  queryFn: getConnectedClients,
});

export function adminToolsQueryOptions(providerId: ProviderId) {
  return queryOptions({
    queryKey: ['admin-tools', providerId],
    queryFn: () => getAdminProviderTools(providerId),
    staleTime: (query) => staleTimeFromServer(query.state.data?.cache.freshForMs),
    refetchInterval: (query) => nextRefetchFromServer(
      query.state.data?.cache.nextCheckInMs,
      query.state.dataUpdatedAt,
    ),
  });
}

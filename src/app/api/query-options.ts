import { queryOptions } from '@tanstack/react-query';
import { getConnectedClients, getProviders } from './bifrost';

export const providersQueryOptions = queryOptions({
  queryKey: ['providers'],
  queryFn: getProviders,
});

export const connectedClientsQueryOptions = queryOptions({
  queryKey: ['connected-clients'],
  queryFn: getConnectedClients,
});

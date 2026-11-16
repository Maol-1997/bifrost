import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { connectedClientsQueryOptions, providersQueryOptions } from './query-options';

// Server events name what changed; invalidating the matching key refetches the
// truth. The bare 'admin-tools' prefix covers every provider's detail query.
const QUERY_KEY_BY_EVENT: Record<string, readonly unknown[]> = {
  'providers-changed': providersQueryOptions.queryKey,
  'clients-changed': connectedClientsQueryOptions.queryKey,
  'admin-tools-changed': ['admin-tools'],
};

/**
 * Keeps this tab in sync with changes made elsewhere: another tab, an OAuth
 * callback finishing, or an admin editing deployment policies. Must only run
 * signed in — an unauthenticated EventSource would fail on the 401.
 */
export function useLiveInvalidations(isSignedIn: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isSignedIn || import.meta.env.VITE_USE_MOCK_API === 'true') return;
    const source = new EventSource('/api/events');
    for (const [event, queryKey] of Object.entries(QUERY_KEY_BY_EVENT)) {
      source.addEventListener(event, () => {
        void queryClient.invalidateQueries({ queryKey });
      });
    }
    return () => {
      source.close();
    };
  }, [isSignedIn, queryClient]);
}

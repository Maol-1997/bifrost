import { useQuery } from '@tanstack/react-query';
import { getAppHealth, type HealthSnapshot } from '@app/api/bifrost';

// The server caches the vendors' feeds for a minute. Polling at half that
// means a tab picks up a fresh snapshot within 30s of the cache turning over,
// instead of up to a full minute late if the two clocks line up badly; the
// extra requests are cheap because they hit the cache.
const POLL_INTERVAL_MS = 30_000;

export type AppHealthState = {
  snapshot: HealthSnapshot | undefined;
  hasFailed: boolean;
  reload: () => void;
};

/**
 * Single poller for upstream health, owned by the app shell and shared with the
 * status screen. Two independent pollers could disagree, which would show a
 * sidebar badge that contradicts the table right next to it.
 */
export function useAppHealth(): AppHealthState {
  const query = useQuery({
    queryKey: ['app-health'],
    queryFn: getAppHealth,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: true,
  });

  return {
    snapshot: query.data,
    hasFailed: query.isError || query.isRefetchError,
    reload: () => {
      void query.refetch();
    },
  };
}

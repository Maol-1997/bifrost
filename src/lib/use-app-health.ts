import { useCallback, useEffect, useState } from 'react';
import { getAppHealth, type HealthSnapshot } from '@/api/bifrost';

// The vendors' feeds are cached for a minute server-side, so polling faster
// would only re-fetch the same snapshot; polling slower would make the
// "last checked" line on the status screen lie.
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
  const [snapshot, setSnapshot] = useState<HealthSnapshot | undefined>(undefined);
  const [hasFailed, setHasFailed] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await getAppHealth());
      setHasFailed(false);
    } catch {
      setHasFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  return { snapshot, hasFailed, reload: () => void load() };
}

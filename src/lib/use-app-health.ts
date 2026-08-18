import { useCallback, useEffect, useState } from 'react';
import { getAppHealth, type HealthSnapshot } from '@/api/bifrost';

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

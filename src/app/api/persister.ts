import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { defaultShouldDehydrateQuery, type OmitKeyof } from '@tanstack/react-query';
import type { PersistQueryClientOptions } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';

// Only the providers query (see query-options.ts) is worth painting instantly.
// Session lists and admin-only data must not outlive sign-out or the admin check.
const PERSISTED_QUERY_ROOT = 'providers';
const STORAGE_KEY = 'bifrost-query-cache';
// Bump to discard every previously persisted cache after a breaking shape change.
const CACHE_BUSTER = 'v1';

export const persistOptions: OmitKeyof<PersistQueryClientOptions, 'queryClient'> = {
  buster: CACHE_BUSTER,
  persister: createAsyncStoragePersister({
    key: STORAGE_KEY,
    storage: {
      getItem: async (key) => (await get<string>(key)) ?? null,
      setItem: set,
      removeItem: del,
    },
  }),
  dehydrateOptions: {
    shouldDehydrateQuery: (query) => (
      defaultShouldDehydrateQuery(query) && query.queryKey[0] === PERSISTED_QUERY_ROOT
    ),
  },
};

/** The next account on this browser must not inherit the previous one's cache. */
export async function clearPersistedQueries(): Promise<void> {
  await del(STORAGE_KEY);
}

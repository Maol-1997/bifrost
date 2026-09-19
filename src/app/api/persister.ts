import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { defaultShouldDehydrateQuery, type OmitKeyof, type QueryClient } from '@tanstack/react-query';
import type { PersistQueryClientOptions } from '@tanstack/react-query-persist-client';
import type { Persister } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';

// Only the providers query (see query-options.ts) is worth painting instantly.
// Session lists and admin-only data must not outlive sign-out or the admin check.
const PERSISTED_QUERY_ROOT = 'providers';
const STORAGE_KEY = 'bifrost-query-cache';
// Which account the persisted snapshot belongs to. The snapshot is restored
// before anyone is known to be signed in, so ownership is checked afterwards.
const OWNER_KEY = 'bifrost-query-cache-owner';
// Bump to discard every previously persisted cache after a breaking shape change.
const CACHE_BUSTER = 'v1';

/** The design preview must never read or pollute a real user's persisted cache. */
export const isPersistenceEnabled = import.meta.env.VITE_USE_MOCK_API !== 'true';

// Saves are throttled, so one queued before sign-out could land after the
// clear and hand the snapshot to the next account. Once cleared, this page
// never writes again; sign-out and the 401 path both navigate away.
let isPersistenceStopped = false;

const storagePersister = createAsyncStoragePersister({
  key: STORAGE_KEY,
  storage: {
    getItem: async (key) => (await get<string>(key)) ?? null,
    setItem: set,
    removeItem: del,
  },
});

/**
 * Saves fire on every cache event, so while the providers query is still
 * pending (or just errored) the dehydrated state is empty. Writing that would
 * wipe the good snapshot the next reload needs; sign-out clears explicitly.
 */
const persister: Persister = {
  ...storagePersister,
  persistClient: (client) => {
    if (isPersistenceStopped || client.clientState.queries.length === 0) return;
    return storagePersister.persistClient(client);
  },
};

export const persistOptions: OmitKeyof<PersistQueryClientOptions, 'queryClient'> = {
  buster: CACHE_BUSTER,
  persister,
  dehydrateOptions: {
    shouldDehydrateQuery: (query) => (
      defaultShouldDehydrateQuery(query) && query.queryKey[0] === PERSISTED_QUERY_ROOT
    ),
  },
};

/** The next account on this browser must not inherit the previous one's cache. */
export async function clearPersistedQueries(): Promise<void> {
  isPersistenceStopped = true;
  await Promise.all([del(STORAGE_KEY), del(OWNER_KEY)]);
}

/**
 * Called once the signed-in account is known. A snapshot restored for someone
 * else (a session that expired without sign-out, then a colleague signing in
 * on the same browser) is dropped from memory and disk before it is trusted.
 */
export async function claimPersistedQueries(queryClient: QueryClient, ownerEmail: string): Promise<void> {
  if (!isPersistenceEnabled) return;
  if (await get<string>(OWNER_KEY) === ownerEmail) return;
  queryClient.removeQueries({ queryKey: [PERSISTED_QUERY_ROOT] });
  await del(STORAGE_KEY);
  await set(OWNER_KEY, ownerEmail);
}

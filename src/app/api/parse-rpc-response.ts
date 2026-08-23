import { parseResponse } from 'hono/client';
import type { ClientResponse } from 'hono/client';
import { APP_ROUTES } from '@features/utils/routes';
import { clearPersistedQueries } from './persister';

export async function parseRpcResponse<ResponseType extends ClientResponse<unknown>>(
  request: Promise<ResponseType>,
) {
  const response = await request;
  if (response.status === 401) {
    // A failed clear must not trap the visitor outside the sign-in screen.
    await clearPersistedQueries().catch(() => undefined);
    window.location.assign(APP_ROUTES.signIn);
    throw new Error('Authentication required');
  }
  return parseResponse(response);
}

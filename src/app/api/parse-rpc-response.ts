import { parseResponse } from 'hono/client';
import type { ClientResponse } from 'hono/client';
import { APP_ROUTES } from '@features/utils/routes';

export async function parseRpcResponse<ResponseType extends ClientResponse<unknown>>(
  request: Promise<ResponseType>,
) {
  const response = await request;
  if (response.status === 401) {
    window.location.assign(APP_ROUTES.signIn);
    throw new Error('Authentication required');
  }
  return parseResponse(response);
}

import { hc } from 'hono/client';
import type { AppType } from '../../server/http/app.js';

/** Creates the typed Fetch client without coupling consumers to a browser runtime. */
export function createBifrostClient(baseUrl: string) {
  return hc<AppType>(baseUrl);
}

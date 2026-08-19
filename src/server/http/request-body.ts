import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import type { AppContext, AppEnv } from './context.js';

export const MAX_REQUEST_BODY_BYTES = 1_048_576;

export const limitRequestBody: MiddlewareHandler<AppEnv> = bodyLimit({
  maxSize: MAX_REQUEST_BODY_BYTES,
  onError: (context) => context.json({ error: 'Request body too large' }, 413),
});

export async function readJsonBody(context: AppContext): Promise<unknown> {
  try {
    return await context.req.json<unknown>();
  } catch {
    throw new HTTPException(400, {
      res: context.json({ error: 'Invalid JSON request body' }, 400),
    });
  }
}

export async function readFormBody(context: AppContext): Promise<URLSearchParams> {
  return new URLSearchParams(await context.req.text());
}

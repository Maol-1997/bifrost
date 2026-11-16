import { z } from 'zod';

const slackUserTokens = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

const slackTokenResponse = z.object({ authed_user: z.unknown().optional() }).loose();

/** Presents Slack's user grant and nonstandard `user` token type as a standard bearer response. */
export async function normalizeSlackTokenResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const parsed = slackTokenResponse.safeParse(await response.clone().json());
  if (!parsed.success) return response;
  const nestedUserTokens = slackUserTokens.safeParse(parsed.data.authed_user);
  const topLevelUserTokens = slackUserTokens.safeParse(parsed.data);
  const userTokens = nestedUserTokens.success
    ? nestedUserTokens.data
    : topLevelUserTokens.success
      ? topLevelUserTokens.data
      : undefined;
  if (!userTokens) return response;

  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'application/json');
  headers.delete('Content-Length');
  return Response.json(
    {
      ...parsed.data,
      access_token: userTokens.access_token,
      token_type: 'bearer',
      ...(userTokens.refresh_token ? { refresh_token: userTokens.refresh_token } : {}),
      ...(userTokens.expires_in ? { expires_in: userTokens.expires_in } : {}),
      ...(userTokens.scope ? { scope: userTokens.scope } : {}),
    },
    { status: response.status, headers },
  );
}

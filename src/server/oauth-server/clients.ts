import { lookup } from 'node:dns/promises';
import { z } from 'zod';
import { OAuthError } from './errors.js';
import { isRedirectUriRegistrable } from './redirect-uri.js';
import { isPubliclyRoutableAddress } from './ssrf.js';

/**
 * The two ways a client comes to exist.
 *
 * `dynamic` is RFC 7591 registration, which the 2026-07-28 spec deprecates but
 * every shipping client still falls back to. `metadata-document` is its
 * replacement: the `client_id` is an HTTPS URL that serves the client's own
 * metadata, so nothing has to be stored ahead of time.
 */
export type ClientRegistrationKind = 'dynamic' | 'metadata-document';

export type RegisteredClient = {
  clientId: string;
  clientName: string;
  redirectUris: readonly string[];
  registrationKind: ClientRegistrationKind;
};

const DOCUMENT_TIMEOUT_MS = 5_000;
const DOCUMENT_MAX_BYTES = 65_536;
const DOCUMENT_MIN_CACHE_MS = 300_000;
const DOCUMENT_DEFAULT_CACHE_MS = 3_600_000;
const DOCUMENT_MAX_CACHE_MS = 86_400_000;
const MAX_REDIRECT_URIS = 20;

const registrationRequestSchema = z.object({
  client_name: z.string().min(1).max(200).optional(),
  redirect_uris: z.array(z.string().min(1)).min(1).max(MAX_REDIRECT_URIS),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
}).loose();

const clientMetadataDocumentSchema = z.object({
  client_id: z.string().min(1),
  client_name: z.string().min(1).max(200),
  redirect_uris: z.array(z.string().min(1)).min(1).max(MAX_REDIRECT_URIS),
}).loose();

/** The one place the supported grants are named; metadata, registration and the token endpoint all read it. */
export const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
const supportedGrantTypeSet = new Set<string>(SUPPORTED_GRANT_TYPES);

/**
 * A `client_id` that is an HTTPS URL with a path is a Client ID Metadata
 * Document, per draft-ietf-oauth-client-id-metadata-document. The path
 * requirement is what keeps a bare origin from being mistaken for one.
 */
export function isClientIdMetadataDocumentUrl(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:' && url.pathname !== '/' && url.hash === '';
  } catch {
    return false;
  }
}

/**
 * Validates a dynamic registration request into the fields Bifrost stores.
 *
 * Clients are always public: no secret is issued, so the only thing binding an
 * authorization code to its requester is PKCE.
 */
export function parseRegistrationRequest(payload: unknown): { clientName: string; redirectUris: readonly string[] } {
  const parsed = registrationRequestSchema.safeParse(payload);
  if (!parsed.success) throw new OAuthError('invalid_request', 'Registration requires redirect_uris');
  const { client_name: clientName, redirect_uris: redirectUris, grant_types: grantTypes, response_types: responseTypes, token_endpoint_auth_method: authMethod } = parsed.data;
  if (grantTypes?.some((grantType) => !supportedGrantTypeSet.has(grantType))) {
    throw new OAuthError('invalid_request', `Only the ${SUPPORTED_GRANT_TYPES.join(' and ')} grants are supported`);
  }
  // Absent means "code" per RFC 7591; an empty list or anything else declares a
  // flow this server does not run, and registering it would only defer the failure.
  if (responseTypes !== undefined && (responseTypes.length === 0 || responseTypes.some((responseType) => responseType !== 'code'))) {
    throw new OAuthError('invalid_request', 'Only the code response type is supported');
  }
  if (authMethod !== undefined && authMethod !== 'none') {
    throw new OAuthError('invalid_request', 'Only public clients are supported, so token_endpoint_auth_method must be none');
  }
  assertRegistrableRedirectUris(redirectUris);
  return { clientName: clientName ?? 'Unnamed MCP client', redirectUris };
}

/** RFC 7591 registration response. `client_secret` is absent because these are public clients. */
export function registrationResponse(client: RegisteredClient): Record<string, unknown> {
  return {
    client_id: client.clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: [...SUPPORTED_GRANT_TYPES],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/**
 * Validates a fetched metadata document.
 *
 * The `client_id` inside the document has to match the URL it came from. That
 * one check is what stops anyone who can host a JSON file from claiming to be
 * somebody else's client.
 */
export function parseClientMetadataDocument(clientId: string, payload: unknown): RegisteredClient {
  const parsed = clientMetadataDocumentSchema.safeParse(payload);
  if (!parsed.success) throw new OAuthError('invalid_client', 'Client metadata document is missing client_id, client_name or redirect_uris');
  if (parsed.data.client_id !== clientId) throw new OAuthError('invalid_client', 'Client metadata document does not claim the URL it was served from');
  assertRegistrableRedirectUris(parsed.data.redirect_uris);
  return {
    clientId,
    clientName: parsed.data.client_name,
    redirectUris: parsed.data.redirect_uris,
    registrationKind: 'metadata-document',
  };
}

/**
 * Fetches and validates a Client ID Metadata Document.
 *
 * Every address the hostname resolves to has to be publicly routable, and
 * redirects are not followed, so a 302 cannot be used to hop from a public name
 * onto an internal address. The gap this leaves is deliberate and unavoidable:
 * DNS is re-resolved by `fetch`, so a record that changes between the check and
 * the request would slip past — a rebinding window that closing properly would
 * need a pinned-IP agent. The exposure is bounded by `handleAuthorize` refusing
 * to resolve a client until the browser has a signed-in session.
 */
export async function fetchClientMetadataDocument(clientId: string): Promise<{ client: RegisteredClient; cacheForMs: number }> {
  if (!isClientIdMetadataDocumentUrl(clientId)) throw new OAuthError('invalid_client', 'A client_id URL must use https and include a path');
  await assertPubliclyRoutableHost(new URL(clientId).hostname);
  const response = await fetch(clientId, {
    redirect: 'manual',
    signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  }).catch(() => { throw new OAuthError('invalid_client', 'Could not reach the client metadata document'); });
  if (!response.ok) throw new OAuthError('invalid_client', `Client metadata document responded with status ${response.status}`);
  const body = await readCapped(response);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new OAuthError('invalid_client', 'Client metadata document is not valid JSON');
  }
  return { client: parseClientMetadataDocument(clientId, payload), cacheForMs: cacheLifetimeMs(response.headers.get('cache-control')) };
}

function assertRegistrableRedirectUris(redirectUris: readonly string[]): void {
  const invalid = redirectUris.find((uri) => !isRedirectUriRegistrable(uri));
  if (invalid !== undefined) {
    throw new OAuthError('invalid_request', 'Every redirect_uri must use https or point at loopback, and must not contain a fragment');
  }
}

async function assertPubliclyRoutableHost(hostname: string): Promise<void> {
  const addresses = await lookup(hostname, { all: true })
    .catch(() => { throw new OAuthError('invalid_client', 'Could not resolve the client metadata document host'); });
  if (addresses.length === 0 || !addresses.every((entry) => isPubliclyRoutableAddress(entry.address))) {
    throw new OAuthError('invalid_client', 'Client metadata documents must be hosted on a publicly routable address');
  }
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > DOCUMENT_MAX_BYTES) {
      await reader.cancel();
      throw new OAuthError('invalid_client', 'Client metadata document is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Honours `Cache-Control: max-age` within bounds. The floor stops a hostile or
 * misconfigured document from turning every authorization into a fresh fetch;
 * the ceiling stops a rotated `redirect_uris` list from taking a day to apply.
 */
function cacheLifetimeMs(cacheControl: string | null): number {
  const maxAge = /max-age=(\d+)/.exec(cacheControl ?? '')?.[1];
  if (maxAge === undefined) return DOCUMENT_DEFAULT_CACHE_MS;
  return Math.min(Math.max(Number(maxAge) * 1000, DOCUMENT_MIN_CACHE_MS), DOCUMENT_MAX_CACHE_MS);
}

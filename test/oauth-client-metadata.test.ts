import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchClientMetadataDocument,
  isClientIdMetadataDocumentUrl,
  parseClientMetadataDocument,
  parseRegistrationRequest,
  registrationResponse,
} from '../src/server/oauth-server/clients.js';
import { OAuthError } from '../src/server/oauth-server/errors.js';

const documentUrl = 'https://app.example.com/oauth/client.json';

const validDocument = {
  client_id: documentUrl,
  client_name: 'Example MCP Client',
  redirect_uris: ['http://127.0.0.1:3000/callback'],
};

describe('recognising a client_id metadata document', () => {
  it('requires https and a path, so a bare origin is not mistaken for one', () => {
    expect(isClientIdMetadataDocumentUrl(documentUrl)).toBe(true);
    expect(isClientIdMetadataDocumentUrl('https://app.example.com')).toBe(false);
    expect(isClientIdMetadataDocumentUrl('https://app.example.com/')).toBe(false);
    expect(isClientIdMetadataDocumentUrl('http://app.example.com/client.json')).toBe(false);
  });

  it('treats an opaque registered id as not being a document URL', () => {
    expect(isClientIdMetadataDocumentUrl('bifrost-abc123')).toBe(false);
  });
});

describe('validating a fetched client metadata document', () => {
  it('accepts a document that claims the URL it came from', () => {
    const client = parseClientMetadataDocument(documentUrl, validDocument);
    expect(client.clientName).toBe('Example MCP Client');
    expect(client.registrationKind).toBe('metadata-document');
  });

  it('refuses a document claiming a different client_id', () => {
    // Without this check anyone who can host JSON could impersonate another
    // client, and the consent screen would show that client's name.
    expect(() =>
      parseClientMetadataDocument(documentUrl, { ...validDocument, client_id: 'https://evil.example.com/c.json' }),
    ).toThrow(OAuthError);
  });

  it('refuses a document missing the fields the consent screen depends on', () => {
    expect(() =>
      parseClientMetadataDocument(documentUrl, { client_id: documentUrl, redirect_uris: ['https://a.example/cb'] }),
    ).toThrow(OAuthError);
    expect(() => parseClientMetadataDocument(documentUrl, { client_id: documentUrl, client_name: 'X' })).toThrow(
      OAuthError,
    );
    expect(() => parseClientMetadataDocument(documentUrl, { ...validDocument, redirect_uris: [] })).toThrow(OAuthError);
  });

  it('refuses redirect URIs that are neither https nor loopback', () => {
    expect(() =>
      parseClientMetadataDocument(documentUrl, { ...validDocument, redirect_uris: ['http://app.example.com/cb'] }),
    ).toThrow(OAuthError);
  });
});

describe('dynamic registration', () => {
  it('takes the redirect URIs and defaults a name when none is offered', () => {
    const registration = parseRegistrationRequest({ redirect_uris: ['https://app.example.com/cb'] });
    expect(registration.redirectUris).toEqual(['https://app.example.com/cb']);
    expect(registration.clientName).toBe('Unnamed MCP client');
  });

  it('refuses a registration with no redirect URI at all', () => {
    expect(() => parseRegistrationRequest({ client_name: 'X' })).toThrow(OAuthError);
    expect(() => parseRegistrationRequest({ redirect_uris: [] })).toThrow(OAuthError);
  });

  it('refuses grants and auth methods Bifrost does not implement', () => {
    expect(() =>
      parseRegistrationRequest({ redirect_uris: ['https://a.example/cb'], grant_types: ['implicit'] }),
    ).toThrow(OAuthError);
  });

  it('rejects response types other than code', () => {
    expect(() =>
      parseRegistrationRequest({ redirect_uris: ['https://a.example/cb'], response_types: ['token'] }),
    ).toThrow(OAuthError);
  });

  it('rejects an empty response type list, which declares no supported flow at all', () => {
    expect(() => parseRegistrationRequest({ redirect_uris: ['https://a.example/cb'], response_types: [] })).toThrow(
      OAuthError,
    );
  });

  it('accepts code as the only response type', () => {
    expect(
      parseRegistrationRequest({ redirect_uris: ['https://a.example/cb'], response_types: ['code'] }).redirectUris,
    ).toEqual(['https://a.example/cb']);
    expect(() =>
      parseRegistrationRequest({
        redirect_uris: ['https://a.example/cb'],
        token_endpoint_auth_method: 'client_secret_post',
      }),
    ).toThrow(OAuthError);
  });

  it('accepts the grants it does implement', () => {
    const registration = parseRegistrationRequest({
      redirect_uris: ['https://a.example/cb'],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    });
    expect(registration.redirectUris).toEqual(['https://a.example/cb']);
  });

  it('never issues a client secret, because these clients cannot keep one', () => {
    const response = registrationResponse({
      clientId: 'bifrost-abc',
      clientName: 'X',
      redirectUris: ['https://a.example/cb'],
      registrationKind: 'dynamic',
    });
    expect(response.client_secret).toBeUndefined();
    expect(response.token_endpoint_auth_method).toBe('none');
  });
});

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn<(hostname: string, options: { all: true }) => Promise<{ address: string; family: number }[]>>(),
}));
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }));

const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();

/** Every case that gets as far as the request needs the host to survive the SSRF check first. */
function resolvesToAPublicAddress(): void {
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
}

function documentOfExactly(byteLength: number): string {
  const json = JSON.stringify(validDocument);
  // Trailing whitespace is ignored by JSON.parse, so padding changes only the size.
  return json + ' '.repeat(byteLength - json.length);
}

describe('fetching a client metadata document', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('refuses a host that resolves to a private address, before making any request', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await expect(fetchClientMetadataDocument(documentUrl)).rejects.toThrow(OAuthError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a host that resolves to nothing at all', async () => {
    lookupMock.mockResolvedValue([]);
    await expect(fetchClientMetadataDocument(documentUrl)).rejects.toThrow(OAuthError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a redirect instead of following it onto another address', async () => {
    resolvesToAPublicAddress();
    fetchMock.mockResolvedValue(new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } }));
    await expect(fetchClientMetadataDocument(documentUrl)).rejects.toThrow(OAuthError);
    expect(fetchMock.mock.calls[0]?.[1].redirect).toBe('manual');
  });

  it('accepts a document sitting exactly on the size cap', async () => {
    resolvesToAPublicAddress();
    fetchMock.mockResolvedValue(new Response(documentOfExactly(65_536)));
    const { client } = await fetchClientMetadataDocument(documentUrl);
    expect(client.clientName).toBe('Example MCP Client');
  });

  it('refuses a document one byte over the size cap', async () => {
    resolvesToAPublicAddress();
    fetchMock.mockResolvedValue(new Response(documentOfExactly(65_537)));
    await expect(fetchClientMetadataDocument(documentUrl)).rejects.toThrow(OAuthError);
  });

  it('refuses a body that is not JSON', async () => {
    resolvesToAPublicAddress();
    fetchMock.mockResolvedValue(new Response('<html>not json</html>'));
    await expect(fetchClientMetadataDocument(documentUrl)).rejects.toThrow(OAuthError);
  });

  it('refuses a document claiming a client_id other than the URL it was served from', async () => {
    resolvesToAPublicAddress();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ...validDocument, client_id: 'https://evil.example.com/c.json' })),
    );
    await expect(fetchClientMetadataDocument(documentUrl)).rejects.toThrow(OAuthError);
  });

  it('caches for an hour when the document says nothing', async () => {
    resolvesToAPublicAddress();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(validDocument)));
    await expect(fetchClientMetadataDocument(documentUrl)).resolves.toMatchObject({ cacheForMs: 3_600_000 });
  });

  it('honours a max-age that falls inside the bounds', async () => {
    resolvesToAPublicAddress();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(validDocument), { headers: { 'cache-control': 'public, max-age=7200' } }),
    );
    await expect(fetchClientMetadataDocument(documentUrl)).resolves.toMatchObject({ cacheForMs: 7_200_000 });
  });

  it('raises a max-age below the floor, so a hostile document cannot force a fetch per authorization', async () => {
    resolvesToAPublicAddress();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(validDocument), { headers: { 'cache-control': 'max-age=60' } }),
    );
    await expect(fetchClientMetadataDocument(documentUrl)).resolves.toMatchObject({ cacheForMs: 300_000 });
  });

  it('lowers a max-age above the ceiling, so a rotated redirect_uris list still applies within a day', async () => {
    resolvesToAPublicAddress();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(validDocument), { headers: { 'cache-control': 'max-age=999999' } }),
    );
    await expect(fetchClientMetadataDocument(documentUrl)).resolves.toMatchObject({ cacheForMs: 86_400_000 });
  });
});

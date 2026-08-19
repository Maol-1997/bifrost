import { describe, expect, it } from 'vitest';
import {
  authorizationServerMetadata, bearerChallenge, canonicalResource, issuerUrl,
  protectedResourceMetadata, protectedResourceMetadataUrl,
} from '../src/server/oauth-server/metadata.js';

describe('issuer identification', () => {
  it('strips trailing slashes, which a client compares byte for byte', () => {
    // RFC 8414 makes a client reject metadata whose issuer differs at all from
    // the value it built the discovery URL from, slash included.
    expect(issuerUrl('https://bifrost.example/')).toBe('https://bifrost.example');
    expect(issuerUrl('https://bifrost.example///')).toBe('https://bifrost.example');
    expect(issuerUrl('https://bifrost.example')).toBe('https://bifrost.example');
  });

  it('names the MCP endpoint as the audience, not the origin', () => {
    expect(canonicalResource('https://bifrost.example/')).toBe('https://bifrost.example/mcp');
  });

  it('publishes resource metadata under the resource path, as RFC 9728 requires', () => {
    expect(protectedResourceMetadataUrl('https://bifrost.example'))
      .toBe('https://bifrost.example/.well-known/oauth-protected-resource/mcp');
  });
});

describe('protected resource metadata', () => {
  const document = protectedResourceMetadata('https://bifrost.example');

  it('points at an authorization server and declares the audience', () => {
    expect(document.resource).toBe('https://bifrost.example/mcp');
    expect(document.authorization_servers).toEqual(['https://bifrost.example']);
  });

  it('offers the bearer header and the one scope Bifrost issues', () => {
    expect(document.scopes_supported).toEqual(['mcp']);
    expect(document.bearer_methods_supported).toEqual(['header']);
  });
});

describe('authorization server metadata', () => {
  const document = authorizationServerMetadata('https://bifrost.example/', true);

  it('advertises PKCE, without which a conforming client must refuse to proceed', () => {
    expect(document.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('declares public clients, which is also what unlocks the metadata-document path', () => {
    expect(document.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(document.client_id_metadata_document_supported).toBe(true);
  });

  it('can turn the metadata-document path off without touching anything else', () => {
    const disabled = authorizationServerMetadata('https://bifrost.example', false);
    expect(disabled.client_id_metadata_document_supported).toBe(false);
    expect(disabled.registration_endpoint).toBe('https://bifrost.example/oauth/register');
  });

  it('states the issuer and every endpoint against it', () => {
    expect(document.issuer).toBe('https://bifrost.example');
    expect(document.authorization_endpoint).toBe('https://bifrost.example/oauth/authorize');
    expect(document.token_endpoint).toBe('https://bifrost.example/oauth/token');
    expect(document.revocation_endpoint).toBe('https://bifrost.example/oauth/revoke');
  });

  it('supports refreshing, which is the whole point of the flow', () => {
    expect(document.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(document.authorization_response_iss_parameter_supported).toBe(true);
  });
});

describe('bearer challenge', () => {
  it('carries the discovery URL, which is all an unauthenticated client has to go on', () => {
    expect(bearerChallenge('https://bifrost.example'))
      .toBe('Bearer resource_metadata="https://bifrost.example/.well-known/oauth-protected-resource/mcp", scope="mcp"');
  });

  it('says invalid_token when a credential was presented, so the client refreshes instead of re-registering', () => {
    expect(bearerChallenge('https://bifrost.example', 'invalid_token'))
      .toBe('Bearer error="invalid_token", resource_metadata="https://bifrost.example/.well-known/oauth-protected-resource/mcp", scope="mcp"');
  });
});

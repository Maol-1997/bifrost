import { describe, expect, it } from 'vitest';
import { isLoopbackOnly, isRedirectUriAllowed, isRedirectUriRegistrable, redirectUriHost } from '../src/oauth-server/redirect-uri.js';

describe('redirect URI registration rules', () => {
  it('accepts https anywhere and http only on loopback', () => {
    expect(isRedirectUriRegistrable('https://app.example.com/callback')).toBe(true);
    expect(isRedirectUriRegistrable('http://127.0.0.1:3118/callback')).toBe(true);
    expect(isRedirectUriRegistrable('http://localhost/callback')).toBe(true);
    expect(isRedirectUriRegistrable('http://app.example.com/callback')).toBe(false);
  });

  it('refuses fragments, which the authorization response could not survive', () => {
    expect(isRedirectUriRegistrable('https://app.example.com/callback#done')).toBe(false);
  });

  it('refuses anything it cannot parse as a URL', () => {
    expect(isRedirectUriRegistrable('not a url')).toBe(false);
    expect(isRedirectUriRegistrable('/callback')).toBe(false);
  });
});

describe('redirect URI matching', () => {
  const registered = ['https://app.example.com/callback'];

  it('matches a registered https URI exactly', () => {
    expect(isRedirectUriAllowed('https://app.example.com/callback', registered)).toBe(true);
  });

  it('refuses a different path, query or scheme on an https URI', () => {
    expect(isRedirectUriAllowed('https://app.example.com/callback2', registered)).toBe(false);
    expect(isRedirectUriAllowed('https://app.example.com/callback?next=x', registered)).toBe(false);
    expect(isRedirectUriAllowed('http://app.example.com/callback', registered)).toBe(false);
    expect(isRedirectUriAllowed('https://evil.example.com/callback', registered)).toBe(false);
  });

  it('refuses a different port on an https URI, where nothing picks one at runtime', () => {
    expect(isRedirectUriAllowed('https://app.example.com:8443/callback', registered)).toBe(false);
  });

  it('allows any port on loopback, which is what RFC 8252 §7.3 exists for', () => {
    // The case that matters in practice: a native client registers without a
    // port and binds an ephemeral one when it actually starts listening.
    expect(isRedirectUriAllowed('http://localhost:3118/callback', ['http://localhost/callback'])).toBe(true);
    expect(isRedirectUriAllowed('http://127.0.0.1:51234/cb', ['http://127.0.0.1:8080/cb'])).toBe(true);
  });

  it('relaxes the port and nothing else on loopback', () => {
    const loopback = ['http://127.0.0.1:8080/callback'];
    expect(isRedirectUriAllowed('http://127.0.0.1:9999/other', loopback)).toBe(false);
    expect(isRedirectUriAllowed('http://127.0.0.1:9999/callback?x=1', loopback)).toBe(false);
    // Different loopback spellings are different hosts, not interchangeable.
    expect(isRedirectUriAllowed('http://localhost:9999/callback', loopback)).toBe(false);
  });

  it('does not let a loopback request match a registered public address', () => {
    expect(isRedirectUriAllowed('http://localhost:3118/callback', registered)).toBe(false);
  });
});

describe('consent screen helpers', () => {
  it('shows the host a code would be sent to, port included', () => {
    expect(redirectUriHost('http://127.0.0.1:3118/callback')).toBe('127.0.0.1:3118');
    expect(redirectUriHost('https://app.example.com/callback')).toBe('app.example.com');
  });

  it('flags a client that can only receive on this machine', () => {
    expect(isLoopbackOnly(['http://127.0.0.1:3118/cb', 'http://localhost/cb'])).toBe(true);
    expect(isLoopbackOnly(['http://127.0.0.1:3118/cb', 'https://app.example.com/cb'])).toBe(false);
    expect(isLoopbackOnly([])).toBe(false);
  });
});

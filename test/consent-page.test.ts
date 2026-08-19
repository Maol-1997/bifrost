import { describe, expect, it } from 'vitest';
import { type ConsentView, renderConsentPage, renderErrorPage } from '../src/server/oauth-server/consent-page.js';

// Everything on these pages comes from a client's own metadata document, so the
// payload carries each character the escaper is responsible for.
const XSS = `<script>alert(1)</script>"&'`;

function baseView(): ConsentView {
  return {
    clientName: 'Example MCP Client',
    redirectUri: 'https://app.example.com/callback',
    redirectUris: ['https://app.example.com/callback'],
    scopes: ['mcp'],
    userEmail: 'person@example.com',
    consentToken: 'consent-token-abc',
  };
}

describe('escaping on the consent screen', () => {
  it('escapes the client name, which is whatever the metadata document claimed', () => {
    const html = renderConsentPage({ ...baseView(), clientName: XSS });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&#39;');
  });

  it('escapes the signed-in email', () => {
    const html = renderConsentPage({ ...baseView(), userEmail: XSS });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes the scopes it lists', () => {
    const html = renderConsentPage({ ...baseView(), scopes: [XSS] });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes the consent token, which is rendered into a form value', () => {
    const html = renderConsentPage({ ...baseView(), consentToken: XSS });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    // A bare quote here would end the value attribute and let the rest be markup.
    expect(html).toContain('&quot;');
  });

  it('escapes the redirect host, which falls back to the raw URI when it cannot be parsed', () => {
    const html = renderConsentPage({ ...baseView(), redirectUri: `not-a-url ${XSS}` });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes the host inside the loopback warning too', () => {
    const html = renderConsentPage({
      ...baseView(),
      redirectUri: `not-a-url ${XSS}`,
      redirectUris: ['http://127.0.0.1:3000/callback'],
    });
    expect(html).toContain('class="warning"');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('escaping on the error page', () => {
  it('escapes the title, which is rendered in both the heading and the document title', () => {
    const html = renderErrorPage(XSS, 'Nothing was authorized.');
    expect(html).not.toContain('<script>');
    expect(html.match(/&lt;script&gt;/g)).toHaveLength(2);
  });

  it('escapes the detail', () => {
    const html = renderErrorPage('Unknown client', XSS);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

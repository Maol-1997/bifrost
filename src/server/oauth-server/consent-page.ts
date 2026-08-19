import { CONSENT_PATH } from './metadata.js';
import { isLoopbackOnly, redirectUriHost } from './redirect-uri.js';

/**
 * The consent screen and the errors that cannot be redirected.
 *
 * Rendered by the server rather than the SPA on purpose. This is the one screen
 * where the user decides what a program may do in their name, and it has to be
 * readable and correct without depending on a bundle having loaded. It also
 * carries no script, so there is nothing on it that can be made to lie.
 */

export type ConsentView = {
  clientName: string;
  redirectUri: string;
  redirectUris: readonly string[];
  scopes: readonly string[];
  userEmail: string;
  consentToken: string;
};

const STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #161617; color: #f2f2f3; padding: 24px;
    font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width: 100%; max-width: 460px; background: #212122; border: 0.5px solid #3c3d40;
    border-radius: 12px; padding: 28px; box-shadow: 0 3px 8px rgb(0 0 0 / 0.125), 0 2px 5px rgb(0 0 0 / 0.125), 0 1px 1px rgb(0 0 0 / 0.125); }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
  p { font-size: 13px; line-height: 1.55; color: #a1a1a6; margin: 0 0 16px; }
  strong { color: #f2f2f3; font-weight: 600; }
  dl { margin: 0 0 20px; border: 0.5px solid #3c3d40; border-radius: 8px; overflow: hidden; }
  div.row { display: flex; gap: 12px; padding: 10px 12px; font-size: 12.5px; border-bottom: 0.5px solid #3c3d40; }
  div.row:last-child { border-bottom: 0; }
  dt { color: #7c7c82; flex: 0 0 96px; margin: 0; }
  dd { margin: 0; color: #e4e4e6; word-break: break-all; }
  ul { margin: 0 0 20px; padding-left: 18px; font-size: 13px; line-height: 1.7; color: #e4e4e6; }
  .warning { border: 0.5px solid #6b4a12; background: #2a1f0c; color: #e8c07a;
    border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.5; margin: 0 0 20px; }
  form { display: flex; gap: 10px; }
  button { flex: 1; min-height: 38px; border-radius: 8px; font-size: 13px; font-weight: 500;
    cursor: pointer; border: 0.5px solid transparent; font-family: inherit; }
  button[value="approve"] { background: #f2f2f3; color: #161617; }
  button[value="deny"] { background: transparent; color: #a1a1a6; border-color: #3c3d40; }
  .error { color: #f0a3a3; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
`;

export function renderConsentPage(view: ConsentView): string {
  // The redirect host is the security-relevant fact on this page: approving
  // sends an authorization code there, so the user has to be able to see where
  // "there" is before they decide.
  const host = redirectUriHost(view.redirectUri);
  const loopbackWarning = isLoopbackOnly(view.redirectUris)
    ? `<p class="warning">This client receives its response on your own machine (<code>${escapeHtml(host)}</code>).
       Anything running locally can claim that address, so only approve this if you just started this program yourself.</p>`
    : '';
  return page('Authorize client', `
    <h1>Authorize ${escapeHtml(view.clientName)}?</h1>
    <p>It is asking to use Bifrost as <strong>${escapeHtml(view.userEmail)}</strong>.</p>
    <dl>
      <div class="row"><dt>Program</dt><dd>${escapeHtml(view.clientName)}</dd></div>
      <div class="row"><dt>Sends to</dt><dd>${escapeHtml(host)}</dd></div>
      <div class="row"><dt>Access</dt><dd>${escapeHtml(view.scopes.join(', '))}</dd></div>
    </dl>
    ${loopbackWarning}
    <ul>
      <li>It reaches only the apps you have already connected.</li>
      <li>It acts as you, and every call is logged against your account.</li>
      <li>You can disconnect it any time from Agents &amp; sessions.</li>
    </ul>
    <form method="post" action="${CONSENT_PATH}">
      <input type="hidden" name="consent_token" value="${escapeHtml(view.consentToken)}">
      <button type="submit" name="decision" value="deny">Cancel</button>
      <button type="submit" name="decision" value="approve">Authorize</button>
    </form>
  `);
}

/**
 * Used when the request cannot be trusted enough to redirect — an unknown client
 * or a `redirect_uri` that is not registered. Bouncing the user to an
 * unvalidated URI to report the error is exactly the open redirect the checks
 * exist to prevent, so the message stops here.
 */
export function renderErrorPage(title: string, detail: string): string {
  return page(title, `
    <h1 class="error">${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
    <p>Nothing was authorized. Close this tab and try connecting again from your program.</p>
  `);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Bifrost</title>
<style>${STYLES}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/**
 * Every interpolated value on these pages comes from somewhere a user does not
 * control — a client's own metadata document, most of all — so all of it is
 * escaped rather than only the fields that look risky.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

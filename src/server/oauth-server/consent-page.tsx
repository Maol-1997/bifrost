/** @jsxImportSource hono/jsx */
import { CONSENT_PATH } from './metadata.js';
import { renderOAuthPage } from './oauth-page.js';
import { isLoopbackOnly, redirectUriHost } from './redirect-uri.js';

type ConsentView = {
  clientName: string;
  redirectUri: string;
  redirectUris: readonly string[];
  scopes: readonly string[];
  userEmail: string;
  consentToken: string;
};

export function renderConsentPage(view: ConsentView): string {
  // The redirect host is the security decision: approving sends an authorization
  // code there, so it must be visible before the user chooses.
  const host = redirectUriHost(view.redirectUri);
  const warning = isLoopbackOnly(view.redirectUris) ? (
    <p class="warning">
      This client receives its response on your own machine (<code>{host}</code>). Anything running locally can claim
      that address, so only approve this if you just started this program yourself.
    </p>
  ) : null;

  return renderOAuthPage(
    'Authorize client',
    <>
      <h1>Authorize {view.clientName}?</h1>
      <p>
        It is asking to use Bifrost as <strong>{view.userEmail}</strong>.
      </p>
      <dl>
        <div class="row">
          <dt>Program</dt>
          <dd>{view.clientName}</dd>
        </div>
        <div class="row">
          <dt>Sends to</dt>
          <dd>{host}</dd>
        </div>
        <div class="row">
          <dt>Access</dt>
          <dd>{view.scopes.join(', ')}</dd>
        </div>
      </dl>
      {warning}
      <ul>
        <li>It reaches only the apps you have already connected.</li>
        <li>It acts as you, and every call is logged against your account.</li>
        <li>You can disconnect it any time from Sessions.</li>
      </ul>
      <form method="post" action={CONSENT_PATH}>
        <input type="hidden" name="consent_token" value={view.consentToken} />
        <button type="submit" name="decision" value="deny">
          Cancel
        </button>
        <button type="submit" name="decision" value="approve">
          Authorize
        </button>
      </form>
    </>,
  );
}

/** @jsxImportSource hono/jsx */
import { renderOAuthPage } from './oauth-page.js';

/** Stops locally when redirecting would trust an unvalidated client URI. */
export function renderErrorPage(title: string, detail: string): string {
  return renderOAuthPage(title, (
    <>
      <h1 class="error">{title}</h1>
      <p>{detail}</p>
      <p>Nothing was authorized. Close this tab and try connecting again from your program.</p>
    </>
  ));
}

/** @jsxImportSource hono/jsx */
import { renderToString } from 'hono/jsx/dom/server';
import type { Child } from 'hono/jsx';

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

export function renderOAuthPage(title: string, content: Child): string {
  const document = (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{title} · Bifrost</title>
        <style>{STYLES}</style>
      </head>
      <body>
        <main>{content}</main>
      </body>
    </html>
  );
  return `<!doctype html>${renderToString(document)}`;
}

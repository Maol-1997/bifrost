/**
 * Turns what we know about a client (the client id it signed in with and the
 * user agent it sends) into a name a person recognizes on the "Sessions" screen.
 *
 * MCP 2026-07-28 is stateless, so there is no `initialize` handshake carrying
 * `clientInfo`; the user agent really is all we get. When it matches nothing we
 * show it verbatim rather than inventing a friendlier name, because a client the
 * user cannot identify is exactly the one they may want to revoke.
 */

export const WEB_CLIENT_ID = 'bifrost-web';

/**
 * Clients we ship a real brand mark for. Kept separate from the name because
 * recognizing a client and having its logo on hand are different things: most
 * of the list below is identified but drawn as a monogram.
 */
export type ClientLogoId = 'claude-code' | 'codex' | 'cursor' | 'opencode';

export type ClientDescription = { name: string; monogram: string; logo?: ClientLogoId };

const KNOWN_CLIENTS: readonly { pattern: RegExp; name: string; monogram: string; logo?: ClientLogoId }[] = [
  { pattern: /claude[-_ ]?code|claude[-_ ]?cli/i, name: 'Claude Code', monogram: '>_', logo: 'claude-code' },
  { pattern: /claude[-_ ]?desktop/i, name: 'Claude Desktop', monogram: 'CD' },
  { pattern: /chatgpt/i, name: 'ChatGPT', monogram: 'CG' },
  { pattern: /\bcursor\b/i, name: 'Cursor', monogram: 'Cu', logo: 'cursor' },
  // Ahead of `codex` so a client calling itself `opencode` is not read as
  // OpenAI's, and vice versa: neither substring contains the other, but the
  // order makes that independent of how either pattern is edited later.
  { pattern: /open[-_ ]?code/i, name: 'OpenCode', monogram: 'Op', logo: 'opencode' },
  { pattern: /codex/i, name: 'Codex', monogram: 'Cx', logo: 'codex' },
  { pattern: /windsurf/i, name: 'Windsurf', monogram: 'Wi' },
  { pattern: /\bcline\b/i, name: 'Cline', monogram: 'Cl' },
  { pattern: /zed/i, name: 'Zed', monogram: 'Ze' },
  { pattern: /mcp-remote/i, name: 'mcp-remote', monogram: 'MR' },
  { pattern: /modelcontextprotocol|mcp-sdk/i, name: 'MCP SDK client', monogram: 'MC' },
];

export function describeClient(clientId: string, userAgent: string | undefined): ClientDescription {
  if (clientId === WEB_CLIENT_ID) return { name: 'Bifrost web', monogram: 'BW' };
  const haystack = `${clientId} ${userAgent ?? ''}`;
  const known = KNOWN_CLIENTS.find((candidate) => candidate.pattern.test(haystack));
  if (known)
    return {
      name: known.name,
      monogram: known.monogram,
      ...(known.logo ? { logo: known.logo } : {}),
    };
  const fallback = productToken(userAgent) ?? clientId;
  return { name: fallback, monogram: monogramFor(fallback) };
}

/** `foo/1.2.3 (bar)` -> `foo`. Version numbers make the list noisy without helping anyone. */
function productToken(userAgent: string | undefined): string | undefined {
  const token = userAgent?.trim().split(/[\s/]/)[0];
  return token && token.length > 0 ? token : undefined;
}

function monogramFor(name: string): string {
  const letters = name.replace(/[^a-z0-9]/gi, '');
  return letters.length > 0 ? letters.slice(0, 2) : '??';
}

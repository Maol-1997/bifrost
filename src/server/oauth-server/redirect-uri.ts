/**
 * Redirect URI rules for the authorization endpoint.
 *
 * Exact string comparison against the registered values is what stops an
 * attacker from steering an authorization code to a URI the client never
 * registered, so it is the default here. RFC 8252 §7.3 carves out exactly one
 * exception — the port of a loopback URI — and this module implements that one
 * and nothing else.
 */

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

type LoopbackUri = { pathname: string; search: string; hostname: string };

/**
 * Whether a redirect URI is one a client may register at all.
 *
 * The MCP security considerations require every redirect URI to be loopback or
 * HTTPS. Fragments are rejected because the authorization response appends its
 * own query parameters, and a URI carrying a fragment cannot receive them.
 */
export function isRedirectUriRegistrable(value: string): boolean {
  const url = parseUrl(value);
  if (!url || url.hash !== '') return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname);
}

/**
 * Whether an authorization request may redirect to `candidate`.
 *
 * The loopback exception exists because a native client binds an ephemeral port
 * at runtime and cannot know it when it registers. Without it, every desktop
 * agent would have to register all 65535 ports. Only the port is allowed to
 * differ: host, path and query still have to match exactly.
 */
export function isRedirectUriAllowed(candidate: string, registered: readonly string[]): boolean {
  if (registered.includes(candidate)) return true;
  const requested = asLoopbackUri(candidate);
  if (!requested) return false;
  return registered.some((entry) => {
    const allowed = asLoopbackUri(entry);
    return (
      allowed !== undefined &&
      allowed.hostname === requested.hostname &&
      allowed.pathname === requested.pathname &&
      allowed.search === requested.search
    );
  });
}

/** The hostname a consent screen shows the user, so they can see where approving sends them. */
export function redirectUriHost(value: string): string {
  return parseUrl(value)?.host ?? value;
}

/** True when every registered URI is loopback, which the consent screen has to warn about. */
export function isLoopbackOnly(registered: readonly string[]): boolean {
  return registered.length > 0 && registered.every((entry) => asLoopbackUri(entry) !== undefined);
}

function asLoopbackUri(value: string): LoopbackUri | undefined {
  const url = parseUrl(value);
  if (!url || url.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(url.hostname)) return undefined;
  return { hostname: url.hostname, pathname: url.pathname, search: url.search };
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

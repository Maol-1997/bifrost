import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../config.js';
import { SESSION_TTL_SECONDS } from '../db.js';

const MAX_BODY_BYTES = 1_048_576;
export const SESSION_COOKIE = 'bifrost_session';

export function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

export function redirect(response: ServerResponse, location: string): void {
  response.statusCode = 302;
  response.setHeader('Location', location);
  response.end();
}

export function html(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(body);
}

export function sendFile(response: ServerResponse, file: { status: number; contentType: string; body: Buffer }): void {
  response.statusCode = file.status;
  response.setHeader('Content-Type', file.contentType);
  response.setHeader('Cache-Control', file.contentType.startsWith('text/html') ? 'no-cache' : 'public, max-age=31536000, immutable');
  response.end(file.body);
}

export function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
}

export function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function isAllowedHost(request: IncomingMessage, config: Config): boolean {
  const host = headerValue(request, 'host')?.split(':')[0];
  const publicHost = new URL(config.PUBLIC_URL).hostname;
  return host === publicHost || host === 'localhost' || host === '127.0.0.1';
}

export function parseCookies(value?: string): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(value.split(';').map((part) => part.trim().split('=', 2)).filter((pair) => pair.length === 2) as Array<[string, string]>);
}

export function sessionCookie(token: string, config: Config): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}${config.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

export function clearSessionCookie(config: Config): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${config.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return JSON.parse(await readTextBody(request));
}

/** OAuth token, revocation and consent requests are all form-encoded, not JSON. */
export async function readFormBody(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readTextBody(request));
}

async function readTextBody(request: IncomingMessage): Promise<string> {
  // Decoded once at the end: a multibyte character split across two chunks
  // would otherwise be decoded as two replacement characters.
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    receivedBytes += buffer.byteLength;
    if (receivedBytes > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

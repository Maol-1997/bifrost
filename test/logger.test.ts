import { describe, expect, it } from 'vitest';
import { errorSummary, sanitizeForLogs } from '../src/logger.js';

describe('logger redaction', () => {
  it('redacts credentials while retaining required status fields', () => {
    expect(sanitizeForLogs({ statusCode: 200, accessToken: 'sensitive', refresh_token: 'sensitive' })).toEqual({
      statusCode: 200,
      accessToken: '[REDACTED]',
      refresh_token: '[REDACTED]',
    });
  });

  it('redacts a secret nested below non-sensitive keys', () => {
    expect(sanitizeForLogs({ method: 'POST', request: { path: '/mcp', headers: { authorization: 'Bearer abc' } } })).toEqual({
      method: 'POST',
      request: { path: '/mcp', headers: { authorization: '[REDACTED]' } },
    });
  });

  it('redacts inside array elements without disturbing their siblings', () => {
    expect(sanitizeForLogs([{ accessToken: 'x' }, { statusCode: 200 }])).toEqual([
      { accessToken: '[REDACTED]' },
      { statusCode: 200 },
    ]);
  });

  it('normalizes key casing and separators before matching', () => {
    expect(sanitizeForLogs({ 'Access-Token': 'a', ACCESS_TOKEN: 'b', client_secret: 'c', Authorization: 'd' })).toEqual({
      'Access-Token': '[REDACTED]',
      ACCESS_TOKEN: '[REDACTED]',
      client_secret: '[REDACTED]',
      Authorization: '[REDACTED]',
    });
  });

  it('redacts any key whose normalized name ends in token or secret', () => {
    expect(sanitizeForLogs({ githubToken: 'a', sessionToken: 'b', webhookSecret: 'c' })).toEqual({
      githubToken: '[REDACTED]',
      sessionToken: '[REDACTED]',
      webhookSecret: '[REDACTED]',
    });
  });

  it('passes non-sensitive keys through unchanged', () => {
    expect(sanitizeForLogs({ userId: 'u1', statusCode: 204, latencyMs: 12 })).toEqual({
      userId: 'u1',
      statusCode: 204,
      latencyMs: 12,
    });
  });

  it('redacts credential-shaped keys that carry neither a token nor a secret suffix', () => {
    expect(sanitizeForLogs({ apiKey: 'k', password: 'p', private_key: 'pk' })).toEqual({
      apiKey: '[REDACTED]', password: '[REDACTED]', private_key: '[REDACTED]',
    });
  });

  it('leaves primitives and null alone', () => {
    expect(sanitizeForLogs('plain')).toBe('plain');
    expect(sanitizeForLogs(null)).toBeNull();
    expect(sanitizeForLogs(42)).toBe(42);
    expect(sanitizeForLogs(undefined)).toBeUndefined();
  });

  it('scrubs bearer and JWT material out of free-text strings', () => {
    expect(sanitizeForLogs('sent Bearer abc123 upstream')).toBe('sent Bearer [REDACTED] upstream');
    expect(sanitizeForLogs('token eyJhbGciOi.payload.sig expired')).toBe('token [REDACTED] expired');
  });
});

describe('error summaries', () => {
  it('keeps the error name and scrubs credentials from the message', () => {
    expect(errorSummary(new Error('Bearer eyJhbGciOi.payload.sig rejected'))).toEqual({
      errorType: 'Error',
      message: 'Bearer [REDACTED] rejected',
    });
  });

  it('reports a subclass by its own name', () => {
    expect(errorSummary(new TypeError('bad shape'))).toEqual({ errorType: 'TypeError', message: 'bad shape' });
  });

  it('reveals nothing about values thrown that are not Errors', () => {
    const opaque = { errorType: 'UnknownError', message: 'Unknown error' };

    expect(errorSummary('raw string with a secret')).toEqual(opaque);
    expect(errorSummary({ message: 'internal detail' })).toEqual(opaque);
  });
});

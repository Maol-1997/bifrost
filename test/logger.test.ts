import { describe, expect, it } from 'vitest';
import { sanitizeForLogs } from '../src/logger.js';

describe('logger redaction', () => {
  it('redacts credentials while retaining required status fields', () => {
    expect(sanitizeForLogs({ statusCode: 200, accessToken: 'sensitive', refresh_token: 'sensitive' })).toEqual({
      statusCode: 200,
      accessToken: '[REDACTED]',
      refresh_token: '[REDACTED]',
    });
  });
});

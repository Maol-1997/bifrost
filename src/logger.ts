import pino, { type Logger } from 'pino';

const REDACTED = '[REDACTED]';
const SECRET_KEYS = new Set(['token', 'accesstoken', 'refreshtoken', 'secret', 'clientsecret', 'authorization', 'cookie', 'code', 'authcode', 'jwt', 'apikey', 'password', 'privatekey']);
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const BEARER_PATTERN = /Bearer\s+[^\s,]+/gi;

function sanitizeString(value: string): string {
  return value.replace(JWT_PATTERN, REDACTED).replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
}

export function sanitizeForLogs(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeForLogs);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      isSecretKey(key) ? REDACTED : sanitizeForLogs(entry),
    ]));
  }
  return value;
}

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-z]/gi, '').toLowerCase();
  return SECRET_KEYS.has(normalized) || normalized.endsWith('token') || normalized.endsWith('secret');
}

const baseLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['*.token', '*.accessToken', '*.refreshToken', '*.authorization', '*.cookie', '*.code', '*.jwt', '*.clientSecret'],
    censor: REDACTED,
  },
  hooks: {
    logMethod(argumentsList, method): void {
      const sanitizedArguments = argumentsList.map(sanitizeForLogs);
      const firstArgument = sanitizedArguments[0];
      const message = sanitizedArguments[1];
      if (firstArgument === undefined) return;
      if (typeof firstArgument === 'string') method.call(this, firstArgument);
      else if (typeof message === 'string') method.call(this, firstArgument, message);
      else method.call(this, firstArgument);
    },
  },
});

export const logger: Logger = baseLogger;

export function errorSummary(error: unknown): { errorType: string; message: string } {
  if (error instanceof Error) return { errorType: error.name, message: sanitizeString(error.message) };
  return { errorType: 'UnknownError', message: 'Unknown error' };
}

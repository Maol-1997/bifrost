import { z } from 'zod';
import { parseAccessList, type AccessPolicy } from './security/access.js';
import { ENCRYPTION_KEY_BYTES, LEGACY_KEY_ID, type EncryptionKeyring } from './security/secrets.js';

export const DEVELOPMENT_DATABASE_URL = 'postgres://bifrost:bifrost@localhost:5432/bifrost';

const optionalNonEmptyString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);
const optionalOpenAIBaseUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.url().default('https://api.openai.com/v1'),
);
const openAIModel = z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).default('gpt-6-sol'));
const openRouterBaseUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.url().default('https://openrouter.ai/api'),
);
const jevModel = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).default('typesafe/jev-1.13'),
);
const openAIReasoningEffort = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1).default(DEVELOPMENT_DATABASE_URL),
  // Postgres connections per process, shared by every request.
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
  REDIS_URL: z.url().optional(),
  // ENCRYPTION_KEY alone is the original single-key setup, read as key id
  // `legacy`. Rotation adds ENCRYPTION_KEYS ({"id": "base64"}) and names the
  // key new writes use with ENCRYPTION_ACTIVE_KEY_ID.
  ENCRYPTION_KEY: optionalNonEmptyString,
  ENCRYPTION_KEYS: optionalNonEmptyString,
  ENCRYPTION_ACTIVE_KEY_ID: optionalNonEmptyString,
  GOOGLE_CLIENT_ID: optionalNonEmptyString,
  GOOGLE_CLIENT_SECRET: optionalNonEmptyString,
  GITHUB_CLIENT_ID: optionalNonEmptyString,
  GITHUB_CLIENT_SECRET: optionalNonEmptyString,
  SLACK_CLIENT_ID: optionalNonEmptyString,
  SLACK_CLIENT_SECRET: optionalNonEmptyString,
  OPENAI_API_KEY: optionalNonEmptyString,
  OPENAI_BASE_URL: optionalOpenAIBaseUrl,
  OPENAI_MODEL: openAIModel,
  OPENAI_REASONING_EFFORT: openAIReasoningEffort,
  // Only used to classify tools against an administrator's automatic rule.
  // Without it no rule can run, and new tools stay blocked as before.
  OPENROUTER_API_KEY: optionalNonEmptyString,
  OPENROUTER_BASE_URL: openRouterBaseUrl,
  JEV_MODEL: jevModel,
  // Short by design: a leaked access token stays useful for at most this long,
  // and the client replaces it silently with its refresh token.
  OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  // Slid forward on every rotation, so this is really "how long a client may
  // stay silent before it has to be reconnected by hand".
  OAUTH_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(90),
  // Client ID Metadata Documents replaced dynamic registration in the 2026-07-28
  // spec. Switchable because advertising support decides which path a client
  // takes, and a client with a broken CIMD implementation does not fall back.
  OAUTH_ENABLE_CLIENT_ID_METADATA_DOCUMENTS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  // Comma-separated. Both empty means any verified Google account may sign in.
  ALLOWED_EMAIL_DOMAINS: z.string().default(''),
  ALLOWED_EMAILS: z.string().default(''),
  // Exact addresses only. Domain-wide administration is deliberately unsupported.
  ADMIN_EMAILS: z.string().default(''),
  BIFROST_DEV_USER_ID: z.preprocess((value) => (value === '' ? undefined : value), z.uuid().optional()),
  // How many reverse proxies in front of Bifrost append to X-Forwarded-For.
  // Zero trusts only the socket address, so the header cannot be spoofed.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  SLOW_REQUEST_MS: z.coerce.number().int().positive().default(1000),
  SLOW_TOOL_MS: z.coerce.number().int().positive().default(2000),
  // Connected upstream MCP clients kept per process, one per user and provider.
  UPSTREAM_CLIENT_IDLE_SECONDS: z.coerce.number().int().positive().default(300),
  UPSTREAM_CLIENT_MAX: z.coerce.number().int().positive().default(200),
});

const KEY_GENERATION_HINT = 'Generate one with: openssl rand -base64 32';
const keyIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const encryptionKeysSchema = z.record(keyIdSchema, z.string().min(1));

export type Config = z.infer<typeof environmentSchema> & {
  encryptionKeyring: EncryptionKeyring;
  accessPolicy: AccessPolicy;
  adminEmails: ReadonlySet<string>;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }

  if (parsed.data.NODE_ENV === 'production' && !parsed.data.REDIS_URL) {
    throw new Error('REDIS_URL is required in production');
  }

  const encryptionKeyring = parseEncryptionKeyring(parsed.data);

  // PUBLIC_URL is the OAuth issuer, and OAuth 2.1 requires every authorization
  // server endpoint to be served over TLS. Over plain HTTP the authorization
  // code and the tokens it buys are readable in transit, so this refuses to
  // start. Loopback is the recognized exception and stays allowed for local
  // development.
  if (parsed.data.NODE_ENV === 'production' && !isSecurePublicUrl(parsed.data.PUBLIC_URL)) {
    throw new Error(
      'PUBLIC_URL must use https in production; it is the OAuth issuer and tokens are exchanged against it',
    );
  }

  return {
    ...parsed.data,
    encryptionKeyring,
    accessPolicy: {
      allowedEmailDomains: parseAccessList(parsed.data.ALLOWED_EMAIL_DOMAINS),
      allowedEmails: parseAccessList(parsed.data.ALLOWED_EMAILS),
    },
    adminEmails: parseAccessList(parsed.data.ADMIN_EMAILS),
  };
}

/**
 * Fails at startup rather than at the first credential read: a missing or
 * malformed key would otherwise surface as every connection looking broken.
 */
function parseEncryptionKeyring(environment: {
  ENCRYPTION_KEY?: string | undefined;
  ENCRYPTION_KEYS?: string | undefined;
  ENCRYPTION_ACTIVE_KEY_ID?: string | undefined;
}): EncryptionKeyring {
  const encodedKeys = new Map<string, string>(Object.entries(parseEncryptionKeys(environment.ENCRYPTION_KEYS)));
  if (environment.ENCRYPTION_KEY !== undefined) {
    const listed = encodedKeys.get(LEGACY_KEY_ID);
    if (listed !== undefined && listed !== environment.ENCRYPTION_KEY) {
      throw new Error(`ENCRYPTION_KEY and ENCRYPTION_KEYS.${LEGACY_KEY_ID} are different keys; keep only one`);
    }
    encodedKeys.set(LEGACY_KEY_ID, environment.ENCRYPTION_KEY);
  }
  if (encodedKeys.size === 0) throw new Error(`ENCRYPTION_KEY is required. ${KEY_GENERATION_HINT}`);

  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of encodedKeys) {
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== ENCRYPTION_KEY_BYTES) {
      const name = environment.ENCRYPTION_KEYS === undefined ? 'ENCRYPTION_KEY' : `Encryption key "${keyId}"`;
      throw new Error(`${name} must decode to exactly 32 bytes. ${KEY_GENERATION_HINT}`);
    }
    keys.set(keyId, key);
  }

  // Guessing which key is active would let a typo silently keep writing with
  // the key being retired, so a keyring has to name it.
  if (environment.ENCRYPTION_KEYS !== undefined && environment.ENCRYPTION_ACTIVE_KEY_ID === undefined) {
    throw new Error('ENCRYPTION_ACTIVE_KEY_ID is required when ENCRYPTION_KEYS is set');
  }
  const activeKeyId = environment.ENCRYPTION_ACTIVE_KEY_ID ?? LEGACY_KEY_ID;
  if (!keys.has(activeKeyId)) throw new Error(`ENCRYPTION_ACTIVE_KEY_ID "${activeKeyId}" is not a configured key`);
  return { activeKeyId, keys };
}

function parseEncryptionKeys(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ENCRYPTION_KEYS must be a JSON object of key id to base64 key');
  }
  const keys = encryptionKeysSchema.safeParse(parsed);
  if (!keys.success) throw new Error('ENCRYPTION_KEYS must map ids of letters, digits, ".", "_" or "-" to base64 keys');
  return keys.data;
}

function isSecurePublicUrl(publicUrl: string): boolean {
  const url = new URL(publicUrl);
  return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

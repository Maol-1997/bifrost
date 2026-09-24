import { z } from 'zod';
import { parseAccessList, type AccessPolicy } from './security/access.js';

export const DEVELOPMENT_DATABASE_URL = 'postgres://bifrost:bifrost@localhost:5432/bifrost';

const optionalNonEmptyString = z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional());
const optionalOpenAIBaseUrl = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.url().default('https://api.openai.com/v1'),
);
const openAIModel = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().min(1).default('gpt-6-sol'),
);
const openRouterBaseUrl = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.url().default('https://openrouter.ai/api'),
);
const jevModel = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().min(1).default('typesafe/jev-1.13'),
);
const openAIReasoningEffort = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1).default(DEVELOPMENT_DATABASE_URL),
  REDIS_URL: z.url().optional(),
  ENCRYPTION_KEY: z.string().min(1),
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
  OAUTH_ENABLE_CLIENT_ID_METADATA_DOCUMENTS: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  // Comma-separated. Both empty means any verified Google account may sign in.
  ALLOWED_EMAIL_DOMAINS: z.string().default(''),
  ALLOWED_EMAILS: z.string().default(''),
  // Exact addresses only. Domain-wide administration is deliberately unsupported.
  ADMIN_EMAILS: z.string().default(''),
  BIFROST_DEV_USER_ID: z.preprocess((value) => value === '' ? undefined : value, z.uuid().optional()),
  SLOW_REQUEST_MS: z.coerce.number().int().positive().default(1000),
  SLOW_TOOL_MS: z.coerce.number().int().positive().default(2000),
});

export type Config = z.infer<typeof environmentSchema> & {
  encryptionKey: Buffer;
  accessPolicy: AccessPolicy;
  adminEmails: ReadonlySet<string>;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const missingEncryptionKey = parsed.error.issues.some((issue) => issue.path[0] === 'ENCRYPTION_KEY');
    if (missingEncryptionKey) {
      throw new Error('ENCRYPTION_KEY is required. Generate one with: openssl rand -base64 32');
    }
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }

  if (parsed.data.NODE_ENV === 'production' && !parsed.data.REDIS_URL) {
    throw new Error('REDIS_URL is required in production');
  }

  const encryptionKey = Buffer.from(parsed.data.ENCRYPTION_KEY, 'base64');
  if (encryptionKey.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes. Generate one with: openssl rand -base64 32');
  }

  // PUBLIC_URL is the OAuth issuer, and OAuth 2.1 requires every authorization
  // server endpoint to be served over TLS. Over plain HTTP the authorization
  // code and the tokens it buys are readable in transit, so this refuses to
  // start rather than serving a flow that looks fine and is not. Loopback is the
  // recognized exception and stays allowed for local development.
  if (parsed.data.NODE_ENV === 'production' && !isSecurePublicUrl(parsed.data.PUBLIC_URL)) {
    throw new Error('PUBLIC_URL must use https in production; it is the OAuth issuer and tokens are exchanged against it');
  }

  return {
    ...parsed.data,
    encryptionKey,
    accessPolicy: {
      allowedEmailDomains: parseAccessList(parsed.data.ALLOWED_EMAIL_DOMAINS),
      allowedEmails: parseAccessList(parsed.data.ALLOWED_EMAILS),
    },
    adminEmails: parseAccessList(parsed.data.ADMIN_EMAILS),
  };
}

function isSecurePublicUrl(publicUrl: string): boolean {
  const url = new URL(publicUrl);
  return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

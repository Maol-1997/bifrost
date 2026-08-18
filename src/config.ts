import { z } from 'zod';

const optionalNonEmptyString = z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional());

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1).default('postgres://bifrost:bifrost@localhost:5432/bifrost'),
  REDIS_URL: z.url().optional(),
  ENCRYPTION_KEY: z.string().min(1),
  GOOGLE_CLIENT_ID: optionalNonEmptyString,
  GOOGLE_CLIENT_SECRET: optionalNonEmptyString,
  GITHUB_CLIENT_ID: optionalNonEmptyString,
  GITHUB_CLIENT_SECRET: optionalNonEmptyString,
  LINEAR_CLIENT_ID: optionalNonEmptyString,
  LINEAR_CLIENT_SECRET: optionalNonEmptyString,
  SLACK_CLIENT_ID: optionalNonEmptyString,
  SLACK_CLIENT_SECRET: optionalNonEmptyString,
  WRITE_TOOL_ALLOWLIST: z.string().default(''),
  BIFROST_DEV_USER_ID: z.preprocess((value) => value === '' ? undefined : value, z.uuid().optional()),
  SLOW_REQUEST_MS: z.coerce.number().int().positive().default(1000),
  SLOW_TOOL_MS: z.coerce.number().int().positive().default(2000),
});

export type Config = z.infer<typeof environmentSchema> & {
  encryptionKey: Buffer;
  writeToolAllowlist: ReadonlySet<string>;
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

  const encryptionKey = Buffer.from(parsed.data.ENCRYPTION_KEY, 'base64');
  if (encryptionKey.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes. Generate one with: openssl rand -base64 32');
  }

  return {
    ...parsed.data,
    encryptionKey,
    writeToolAllowlist: new Set(parsed.data.WRITE_TOOL_ALLOWLIST.split(',').map((name) => name.trim()).filter(Boolean)),
  };
}

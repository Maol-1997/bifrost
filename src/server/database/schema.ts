import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { ProviderId } from '../providers/types.js';
import type { EncryptedSecret } from '../security/secrets.js';
import type { ToolContractSnapshot, ToolPolicyState } from '../tools/catalog.js';

const timestampWithTimezone = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: uuid().primaryKey(),
  email: text().notNull().unique(),
  name: text().notNull(),
  createdAt: timestampWithTimezone('created_at').defaultNow().notNull(),
});

export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  id: uuid().defaultRandom().notNull().unique(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull(),
  userAgent: text('user_agent'),
  expiresAt: timestampWithTimezone('expires_at').notNull(),
  createdAt: timestampWithTimezone('created_at').defaultNow().notNull(),
  lastUsedAt: timestampWithTimezone('last_used_at').defaultNow().notNull(),
}, (table) => [index('sessions_user_id_last_used_at_index').on(table.userId, table.lastUsedAt)]);

export const providerCredentials = pgTable('provider_credentials', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  providerId: text('provider_id').$type<ProviderId>().notNull(),
  encryptedPayload: jsonb('encrypted_payload').$type<EncryptedSecret>().notNull(),
  expiresAt: timestampWithTimezone('expires_at'),
  scopes: text().array().default(sql`'{}'::text[]`).notNull(),
  accountLabel: text('account_label'),
  createdAt: timestampWithTimezone('created_at').defaultNow().notNull(),
  updatedAt: timestampWithTimezone('updated_at').defaultNow().notNull(),
}, (table) => [primaryKey({ name: 'provider_credentials_pk', columns: [table.userId, table.providerId] })]);

export const userProviderPreferences = pgTable('user_provider_preferences', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  providerId: text('provider_id').$type<ProviderId>().notNull(),
  isHidden: boolean('is_hidden').default(false).notNull(),
}, (table) => [primaryKey({ name: 'user_provider_preferences_pk', columns: [table.userId, table.providerId] })]);

export const userProviderAgentNotes = pgTable('user_provider_agent_notes', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  providerId: text('provider_id').$type<ProviderId>().notNull(),
  note: text().notNull(),
  updatedAt: timestampWithTimezone('updated_at').defaultNow().notNull(),
}, (table) => [primaryKey({ name: 'user_provider_agent_notes_pk', columns: [table.userId, table.providerId] })]);

export const userToolPreferences = pgTable('user_tool_preferences', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  toolName: text('tool_name').notNull(),
  isEnabled: boolean('is_enabled').notNull(),
}, (table) => [primaryKey({ name: 'user_tool_preferences_pk', columns: [table.userId, table.toolName] })]);

export const deploymentToolPolicies = pgTable('deployment_tool_policies', {
  providerId: text('provider_id').$type<ProviderId>().notNull(),
  toolName: text('tool_name').notNull(),
  fingerprint: text().notNull(),
  contract: jsonb().$type<ToolContractSnapshot>(),
  state: text().$type<ToolPolicyState>().notNull(),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestampWithTimezone('updated_at').defaultNow().notNull(),
}, (table) => [
  primaryKey({ name: 'deployment_tool_policies_pk', columns: [table.providerId, table.toolName] }),
  check('deployment_tool_policies_state_check', sql`${table.state} in ('blocked', 'allowed_default_off', 'allowed_default_on')`),
]);

export const oauthClients = pgTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  clientName: text('client_name').notNull(),
  redirectUris: text('redirect_uris').array().notNull(),
  registrationKind: text('registration_kind').$type<'dynamic' | 'metadata-document'>().notNull(),
  metadataExpiresAt: timestampWithTimezone('metadata_expires_at'),
  createdAt: timestampWithTimezone('created_at').defaultNow().notNull(),
});

export const oauthGrants = pgTable('oauth_grants', {
  id: uuid().defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
  scopes: text().array().notNull(),
  resource: text().notNull(),
  userAgent: text('user_agent'),
  createdAt: timestampWithTimezone('created_at').defaultNow().notNull(),
  lastUsedAt: timestampWithTimezone('last_used_at').defaultNow().notNull(),
}, (table) => [
  unique('oauth_grants_unique_authorization').on(table.userId, table.clientId, table.resource),
  index('oauth_grants_user_id_last_used_at_index').on(table.userId, table.lastUsedAt),
]);

export const oauthAccessTokens = pgTable('oauth_access_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  grantId: uuid('grant_id').notNull().references(() => oauthGrants.id, { onDelete: 'cascade' }),
  expiresAt: timestampWithTimezone('expires_at').notNull(),
}, (table) => [
  index('oauth_access_tokens_grant_id_index').on(table.grantId),
  index('oauth_access_tokens_expires_at_index').on(table.expiresAt),
]);

export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  grantId: uuid('grant_id').notNull().references(() => oauthGrants.id, { onDelete: 'cascade' }),
  expiresAt: timestampWithTimezone('expires_at').notNull(),
  consumedAt: timestampWithTimezone('consumed_at'),
}, (table) => [index('oauth_refresh_tokens_grant_id_index').on(table.grantId)]);

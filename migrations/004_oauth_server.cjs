exports.up = (pgm) => {
  // A client Bifrost has agreed to issue tokens to, whether it registered
  // dynamically or presented a metadata document URL as its client_id.
  pgm.createTable('oauth_clients', {
    client_id: { type: 'text', primaryKey: true },
    client_name: { type: 'text', notNull: true },
    redirect_uris: { type: 'text[]', notNull: true },
    registration_kind: { type: 'text', notNull: true },
    // Metadata-document clients only: when the cached copy stops being trusted
    // and the document has to be fetched again.
    metadata_expires_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // The durable "this person authorized this client" record. Access and refresh
  // tokens are derived from it and come and go; this is the row that "My
  // clients" lists and that revoking actually deletes.
  pgm.createTable('oauth_grants', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    client_id: { type: 'text', notNull: true, references: 'oauth_clients(client_id)', onDelete: 'CASCADE' },
    scopes: { type: 'text[]', notNull: true },
    resource: { type: 'text', notNull: true },
    user_agent: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_used_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // Re-authorizing an already-approved client updates its grant instead of
  // adding a second one, so "Agents & sessions" shows a client once however many times
  // it reconnects.
  pgm.addConstraint('oauth_grants', 'oauth_grants_unique_authorization', { unique: ['user_id', 'client_id', 'resource'] });
  pgm.createIndex('oauth_grants', ['user_id', 'last_used_at']);

  pgm.createTable('oauth_access_tokens', {
    token_hash: { type: 'text', primaryKey: true },
    grant_id: { type: 'uuid', notNull: true, references: 'oauth_grants(id)', onDelete: 'CASCADE' },
    expires_at: { type: 'timestamptz', notNull: true },
  });
  pgm.createIndex('oauth_access_tokens', 'grant_id');
  pgm.createIndex('oauth_access_tokens', 'expires_at');

  // `consumed_at` is what makes rotation detectable. A refresh token is spent on
  // first use; seeing a spent one again means the value leaked, and the grant it
  // belongs to is destroyed rather than refreshed.
  pgm.createTable('oauth_refresh_tokens', {
    token_hash: { type: 'text', primaryKey: true },
    grant_id: { type: 'uuid', notNull: true, references: 'oauth_grants(id)', onDelete: 'CASCADE' },
    expires_at: { type: 'timestamptz', notNull: true },
    consumed_at: { type: 'timestamptz' },
  });
  pgm.createIndex('oauth_refresh_tokens', 'grant_id');

  // Static agent keys are gone: the bearer header now only ever carries an OAuth
  // access token, so these rows can no longer authenticate anything. Left in
  // place they would sit in "Agents & sessions" looking live. Browser sessions, which
  // are what the cookie resolves against, are untouched.
  pgm.sql(`DELETE FROM sessions WHERE client_id IN ('claude-code', 'codex', 'cursor', 'other')`);
};

exports.down = (pgm) => {
  // The deleted agent-key sessions are not restored. They were credentials, so
  // rolling back gives you a server without OAuth rather than one that quietly
  // re-honours keys their owners were told to stop using.
  pgm.dropTable('oauth_refresh_tokens');
  pgm.dropTable('oauth_access_tokens');
  pgm.dropTable('oauth_grants');
  pgm.dropTable('oauth_clients');
};

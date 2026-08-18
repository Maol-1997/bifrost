exports.up = (pgm) => {
  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true },
    email: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTable('sessions', {
    token_hash: { type: 'text', primaryKey: true },
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    client_id: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createTable('provider_credentials', {
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    provider_id: { type: 'text', notNull: true },
    encrypted_payload: { type: 'jsonb', notNull: true },
    expires_at: { type: 'timestamptz' },
    scopes: { type: 'text[]', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('provider_credentials', 'provider_credentials_pk', { primaryKey: ['user_id', 'provider_id'] });
  pgm.createTable('user_provider_preferences', {
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    provider_id: { type: 'text', notNull: true },
    is_hidden: { type: 'boolean', notNull: true, default: false },
  });
  pgm.addConstraint('user_provider_preferences', 'user_provider_preferences_pk', { primaryKey: ['user_id', 'provider_id'] });
};

exports.down = (pgm) => {
  pgm.dropTable('user_provider_preferences');
  pgm.dropTable('provider_credentials');
  pgm.dropTable('sessions');
  pgm.dropTable('users');
};

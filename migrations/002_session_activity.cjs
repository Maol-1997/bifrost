exports.up = (pgm) => {
  // The "Agents & sessions" screen needs a handle it can safely put in a URL. The
  // primary key is a token hash, and hashes of live credentials do not belong
  // in links, logs or browser history — so sessions get an opaque public id.
  pgm.addColumns('sessions', {
    id: { type: 'uuid', notNull: true, default: pgm.func('gen_random_uuid()'), unique: true },
    last_used_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    user_agent: { type: 'text' },
  });
  pgm.createIndex('sessions', ['user_id', 'last_used_at']);
};

exports.down = (pgm) => {
  pgm.dropIndex('sessions', ['user_id', 'last_used_at']);
  pgm.dropColumns('sessions', ['id', 'last_used_at', 'user_agent']);
};

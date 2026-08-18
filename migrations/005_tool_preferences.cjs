exports.up = (pgm) => {
  // One row per tool the user has an opinion about. Absence is not "unknown": it
  // means the default for that kind of tool — reads on, writes off — so a user
  // who never opens the screen still gets a sane, explainable surface without
  // anyone having to seed seventeen rows per account.
  pgm.createTable('user_tool_preferences', {
    user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    tool_name: { type: 'text', notNull: true },
    is_enabled: { type: 'boolean', notNull: true },
  });
  pgm.addConstraint('user_tool_preferences', 'user_tool_preferences_pk', { primaryKey: ['user_id', 'tool_name'] });
};

exports.down = (pgm) => {
  pgm.dropTable('user_tool_preferences');
};

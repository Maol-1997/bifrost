exports.up = (pgm) => {
  // The handle the user authorized as ("@sortega", "sam@…"). Not a secret — it
  // is their own identity and we show it back to them — so it stays in a plain
  // column rather than inside the encrypted credential payload.
  pgm.addColumns('provider_credentials', {
    account_label: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('provider_credentials', ['account_label']);
};

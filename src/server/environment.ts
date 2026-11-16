// Imported first by main.ts. @ai-sdk/anthropic builds a default provider while it is
// being imported and throws on an empty ANTHROPIC_BASE_URL, before loadConfig gets the
// chance to treat a blank value as unset the way it does for every other variable.
if (process.env.ANTHROPIC_BASE_URL === '') {
  delete process.env.ANTHROPIC_BASE_URL;
}

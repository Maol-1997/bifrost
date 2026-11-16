// Imported first by main.ts. @ai-sdk/openai builds a default provider while it is
// being imported and throws on an empty OPENAI_BASE_URL, before loadConfig gets the
// chance to treat a blank value as unset the way it does for every other variable.
if (process.env.OPENAI_BASE_URL === '') {
  delete process.env.OPENAI_BASE_URL;
}

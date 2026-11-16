import { afterEach, describe, expect, it, vi } from 'vitest';

describe('startup environment', () => {
  const original = process.env.OPENAI_BASE_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = original;
    vi.resetModules();
  });

  it('treats an empty OPENAI_BASE_URL as unset before the OpenAI SDK loads', async () => {
    process.env.OPENAI_BASE_URL = '';
    await import('../src/server/environment.js');

    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    await expect(import('@ai-sdk/openai')).resolves.toHaveProperty('createOpenAI');
  });

  it('keeps an explicit OPENAI_BASE_URL', async () => {
    process.env.OPENAI_BASE_URL = 'https://llm.example.test/v1';
    await import('../src/server/environment.js');

    expect(process.env.OPENAI_BASE_URL).toBe('https://llm.example.test/v1');
  });
});

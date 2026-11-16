import { afterEach, describe, expect, it, vi } from 'vitest';

describe('startup environment', () => {
  const original = process.env.ANTHROPIC_BASE_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = original;
    vi.resetModules();
  });

  it('treats an empty ANTHROPIC_BASE_URL as unset before the Anthropic provider loads', async () => {
    process.env.ANTHROPIC_BASE_URL = '';
    await import('../src/server/environment.js');

    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    await expect(import('@ai-sdk/anthropic')).resolves.toHaveProperty('createAnthropic');
  });

  it('keeps an explicit ANTHROPIC_BASE_URL', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://llm.example.test/v1';
    await import('../src/server/environment.js');

    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://llm.example.test/v1');
  });
});

import { describe, expect, it } from 'vitest';
import { SPA_FALLBACK_ROUTES } from '../src/features/utils/routes.js';

describe('SPA fallback route manifest', () => {
  it('preserves wildcard fallbacks for dynamic routes', () => {
    expect(SPA_FALLBACK_ROUTES).toEqual(expect.arrayContaining([
      '/integrations/*',
      '/admin/tools/*',
    ]));
  });

  it('contains the root fallback once', () => {
    expect(SPA_FALLBACK_ROUTES.filter((route) => route === '/')).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { APP_ROUTES, SPA_FALLBACK_ROUTES } from '../src/features/utils/routes.js';

describe('SPA fallback route manifest', () => {
  it('covers every application route', () => {
    for (const route of Object.values(APP_ROUTES)) {
      expect(SPA_FALLBACK_ROUTES).toContain(route.replace(/\/:[^/]+/g, '/*'));
    }
  });

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

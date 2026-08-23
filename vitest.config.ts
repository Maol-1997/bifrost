import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'src/server/http/auth.ts',
        'src/server/oauth-server/{authorize,clients,metadata,pkce,redirect-uri,ssrf,token}.ts',
        'src/server/providers/mcp-client.ts',
        'src/server/security/{access,secrets}.ts',
        'src/server/tools/{catalog,filter}.ts',
      ],
      thresholds: {
        perFile: true,
        statements: 70,
        branches: 70,
        functions: 80,
        lines: 70,
      },
    },
  },
});

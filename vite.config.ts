import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { codeInspectorPlugin } from 'code-inspector-plugin';
import { defineConfig, type PluginOption } from 'vite';

const inspectorPlugin = codeInspectorPlugin({
  bundler: 'vite',
  editor: 'cursor',
  hotKeys: ['metaKey', 'shiftKey'],
  launchType: 'open',
}) as unknown as PluginOption;

const apiTarget = `http://localhost:${process.env.PORT ?? '3000'}`;

export default defineConfig({
  plugins: [inspectorPlugin, react({ jsxImportSource: 'react' }), tailwindcss()],
  resolve: {
    alias: {
      '@app': path.resolve(import.meta.dirname, 'src/app'),
      '@features': path.resolve(import.meta.dirname, 'src/features'),
    },
  },
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': apiTarget,
      '/auth': apiTarget,
      '/oauth': apiTarget,
      '/mcp': apiTarget,
      // OAuth discovery. Without this the setup page cannot read the canonical
      // MCP address, and anything pointed at the dev port fails before it starts.
      '/.well-known': apiTarget,
    },
  },
});

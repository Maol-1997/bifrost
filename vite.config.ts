import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@app': path.resolve(import.meta.dirname, 'src/app'),
      '@features': path.resolve(import.meta.dirname, 'src/features'),
    },
  },
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
      '/oauth': 'http://localhost:3000',
      '/mcp': 'http://localhost:3000',
      // OAuth discovery. Without this the setup page cannot read the canonical
      // MCP address, and anything pointed at the dev port fails before it starts.
      '/.well-known': 'http://localhost:3000',
    },
  },
});

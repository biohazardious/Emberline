import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ['@emberline/source', 'module', 'browser', 'development|production'],
  },
  server: {
    port: 5173,
    proxy: {
      // In compose.dev.yaml this is http://core:7420.
      '/api': { target: process.env.EMBERLINE_CORE_URL ?? 'http://127.0.0.1:7420', ws: true },
    },
  },
});

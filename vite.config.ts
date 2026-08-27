import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_APP_PATH is set by the YunoHost install script to the sub-path the app
// is served under ("/cloud/"). It becomes Vite's `base`, so the hashed asset
// URLs in index.html resolve correctly behind the reverse proxy, and it is
// read back at runtime through import.meta.env.BASE_URL to build API URLs.
const base = process.env.VITE_APP_PATH || '/';

export default defineConfig({
  base,
  build: {
    outDir: 'dist',
    // The server hands these to the browser with a one-year immutable
    // Cache-Control, which is only safe because the names are content-hashed.
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3010', changeOrigin: true },
      '/healthz': { target: 'http://localhost:3010', changeOrigin: true },
    },
  },
});

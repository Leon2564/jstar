import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { '/v1': { target: process.env.API_BASE ?? 'http://localhost:8080', changeOrigin: true } } },
  build: { outDir: 'dist', target: 'es2020' }
});

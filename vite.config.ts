import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { browserBoundaryV1 } from './build/browser-boundary-v1';

export default defineConfig({
  plugins: [react(), tailwindcss(), browserBoundaryV1('admin')],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    sourcemap: false,
    target: 'es2022',
  },
});

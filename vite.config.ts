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
    // React and zod in pieces of their own (issue #1450, 15): their names change only with the package
    // lock, so a deploy of the Centro does not make them download again. The UI libraries keep the
    // default split: grouped, they would load whole on the first page (measured +80 KB gzip).
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[/\\](react|react-dom|scheduler)[/\\]/u },
            { name: 'zod', test: /node_modules[/\\]zod[/\\]/u },
          ],
        },
      },
    },
  },
});

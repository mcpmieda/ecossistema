import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { browserBoundaryV1 } from './build/browser-boundary-v1.ts';

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'src/student-portal'),
  publicDir: false,
  plugins: [react(), tailwindcss(), browserBoundaryV1('student')],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  server: { host: '127.0.0.1', port: 4174, strictPort: true },
  build: {
    outDir: path.resolve(import.meta.dirname, 'node_modules/.cache/student-portal-ui'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    // The libraries in pieces of their own (issue #1426, 39): their names change only with the
    // package lock, so a family's phone keeps them across Portal releases and downloads again only
    // the Portal's own code.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[/\\](react|react-dom|scheduler)[/\\]/u },
            { name: 'ui', test: /node_modules[/\\](@heroui|@react-aria|@react-stately|@react-types|@internationalized|@swc[/\\]helpers|react-aria|react-stately|react-aria-components|framer-motion|motion|motion-dom|motion-utils|tailwind-variants|tailwind-merge|lucide-react)/u },
            { name: 'zod', test: /node_modules[/\\]zod[/\\]/u },
          ],
        },
      },
    },
  },
});

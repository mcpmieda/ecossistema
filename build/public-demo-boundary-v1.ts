import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** Reviewed, versioned synthetic portrait and school artwork; never copy public/ wholesale. */
export const PUBLIC_DEMO_IMAGES_V1: Readonly<Record<string, string>> = {
  'demo-student-boy.webp': '1e0847d737d8af5155831e48fb9c8f7bcc79eefb54dc16f55a5cf843d661b8ae',
  'school-logo.webp': 'b0e5400916b47cd150696cc21b5945422dfec290e21da5007d7da2d8b3f19302',
  'hero-cover.webp': 'd714a51b2eea46515e83d87c86ae7f989c05b4e572515d2d41c6fd1f99bc5b3d',
  'hero-cover-mobile.webp': '8d73753333166e4706292c784e8ba6a93b6c86aa24b72e8d5ac27f9522f596d5',
};

export function publicDemoBoundaryV1(root: string): Plugin {
  const imageDirectory = path.resolve(root, 'src/student-portal/assets');
  return {
    name: 'public-demo-boundary',
    buildStart() {
      for (const [name, expected] of Object.entries(PUBLIC_DEMO_IMAGES_V1)) {
        const bytes = readFileSync(path.join(imageDirectory, name));
        if (createHash('sha256').update(bytes).digest('hex') !== expected)
          this.error(`Public demo asset needs review: ${name}`);
      }
    },
    load(id) {
      const file = id.split('?')[0]!;
      if (/\.(?:webp|png|jpe?g|svg|gif|avif)$/iu.test(file)) {
        if (
          path.dirname(path.resolve(file)) !== imageDirectory ||
          !PUBLIC_DEMO_IMAGES_V1[path.basename(file)]
        )
          this.error('Unreviewed image in public demo');
      }
      return null;
    },
    moduleParsed(info) {
      const file = info.id.replaceAll('\\', '/');
      if (
        /\/local-test\//u.test(file) ||
        /\/src\/features\/student-portal\/(?:auth|photos|live)\//u.test(file)
      )
        this.error('Session, network or local-only module in public demo');
    },
  };
}

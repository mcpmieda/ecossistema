import { z } from 'zod';
import {
  PLATFORM_CAPABILITIES,
  PLATFORM_ROUTES,
  type PlatformSnapshotContract,
} from './platform-contract';

const text = z.string();
const capabilities = z.array(z.enum(PLATFORM_CAPABILITIES));

/** Validate the complete shape used by the rendered Center, not only its top-level arrays. */
export const platformSnapshotSchemaV2 = z.object({
  version: text,
  releaseState: z.literal('production'),
  generatedAt: text,
  correlationId: text,
  coreModules: z.array(
    z.object({
      id: text,
      name: text,
      description: text,
      route: z.enum(PLATFORM_ROUTES),
      state: z.enum(['ready', 'planned']),
      requiredRole: z.literal('ADMINISTRADOR'),
      capabilities,
    }),
  ),
});
export type PlatformSnapshotV2 = PlatformSnapshotContract;

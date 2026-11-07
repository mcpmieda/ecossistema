import { z } from 'zod';

const flagSchema = z.object({
  key: z.string().regex(/^feature\.[a-z0-9-]+\.[a-z0-9-]+$/u),
  active: z.boolean(),
  value: z.unknown().optional(),
});

export function featureFlag(
  records: unknown[],
  module: string,
  flag: string,
  fallback = false,
): boolean {
  const key = `feature.${module}.${flag}`;
  for (const record of records) {
    const parsed = flagSchema.safeParse(record);
    if (parsed.success && parsed.data.key === key) return parsed.data.active;
  }
  return fallback;
}

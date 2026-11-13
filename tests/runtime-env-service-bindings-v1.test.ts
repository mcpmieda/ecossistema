import { describe, expect, it } from 'vitest';
import { validateEnv, type RuntimeEnv } from '../server/env';
import { testEnv } from './fixtures';

describe('runtime env keeps the private service bindings', () => {
  it('passes the Portal, demo and notas-sync bindings through validation', () => {
    const binding = (name: string) => ({ name });
    const env = validateEnv({
      ...testEnv,
      PORTAL_SERVICE: binding('portal'),
      PUBLIC_DEMO_CONTROL: binding('demo'),
      NOTAS_SYNC_SERVICE: binding('notas-sync'),
    } as unknown as RuntimeEnv);
    expect(env.PORTAL_SERVICE).toEqual({ name: 'portal' });
    expect(env.PUBLIC_DEMO_CONTROL).toEqual({ name: 'demo' });
    expect(env.NOTAS_SYNC_SERVICE).toEqual({ name: 'notas-sync' });
  });
});

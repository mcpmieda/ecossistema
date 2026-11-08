// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  integratedModuleContracts,
  moduleContract,
  moduleContractForKey,
  platformBaseModule,
} from '../server/modules/contracts';

describe('extension contracts', () => {
  it('validates the versioned plataforma-base integration contract', () => {
    const parsed = moduleContract.parse(platformBaseModule);
    expect(parsed).toMatchObject({
      contractVersion: 1,
      key: 'plataforma-base',
      requiredCapabilities: ['platform.snapshot.read'],
    });
  });

  it('keeps the Centro contract unique and addressable', () => {
    expect(integratedModuleContracts).toEqual([platformBaseModule]);
    expect(moduleContractForKey('plataforma-base')).toEqual(platformBaseModule);
    expect(moduleContractForKey('nao-registrado')).toBeUndefined();
  });

  it.each(['relative', '//evil.test/path', '/\\evil.test'])(
    'rejects unsafe module routes: %s',
    (route) => {
      expect(() => moduleContract.parse({ ...platformBaseModule, baseRoute: route })).toThrow();
    },
  );

  it('rejects duplicated required capabilities', () => {
    expect(() =>
      moduleContract.parse({
        ...platformBaseModule,
        requiredCapabilities: ['platform.snapshot.read', 'platform.snapshot.read'],
      }),
    ).toThrow();
  });

  it('rejects health endpoints outside the same-origin API namespace', () => {
    expect(() =>
      moduleContract.parse({ ...platformBaseModule, healthEndpoint: '/health' }),
    ).toThrow();
  });
});

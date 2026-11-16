// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { portalAuthBurstV1 } from '../../../server/student-portal/observability/auth-burst-v1';
import { portalServingGateV1 } from '../../../server/student-portal/maintenance/serving-gate-v1';

it('never exports the opaque credential to the limiter and classifies bounded outcomes', async () => {
  const global = { limit: vi.fn().mockResolvedValue({ success: true }) };
  const subject = { limit: vi.fn().mockResolvedValue({ success: true }) };
  const emitted: unknown[] = [];
  const guard = portalAuthBurstV1(global, subject, (metric) => emitted.push(metric));

  expect(await guard('SYNTHETIC_OPAQUE_CREDENTIAL')).toBe(true);
  expect(subject.limit).toHaveBeenCalledWith({ key: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  expect(JSON.stringify(subject.limit.mock.calls)).not.toContain('SYNTHETIC');
  expect(emitted.at(-1)).toEqual({
    event: 'student-portal-auth-burst-v1',
    outcome: 'allowed',
  });

  global.limit.mockResolvedValueOnce({ success: false });
  expect(await guard('SYNTHETIC_OPAQUE_CREDENTIAL')).toBe(false);
  expect(subject.limit).toHaveBeenCalledTimes(1);
  expect(emitted.at(-1)).toEqual({
    event: 'student-portal-auth-burst-v1',
    outcome: 'global-limited',
  });

  global.limit.mockResolvedValueOnce({ success: true });
  subject.limit.mockResolvedValueOnce({ success: false });
  expect(await guard('SYNTHETIC_OPAQUE_CREDENTIAL')).toBe(false);
  expect(emitted.at(-1)).toEqual({
    event: 'student-portal-auth-burst-v1',
    outcome: 'subject-limited',
  });

  expect(await guard('x'.repeat(513))).toBe(false);
  expect(emitted.at(-1)).toEqual({
    event: 'student-portal-auth-burst-v1',
    outcome: 'invalid-subject',
  });

  subject.limit.mockRejectedValueOnce(new Error('provider-private-detail'));
  await expect(guard('SYNTHETIC_OPAQUE_CREDENTIAL')).rejects.toThrow(
    'student-portal-rate-limit-unavailable',
  );
  expect(emitted.at(-1)).toEqual({
    event: 'student-portal-auth-burst-v1',
    outcome: 'unavailable',
  });
  expect(JSON.stringify(emitted)).not.toContain('SYNTHETIC');
});

it('keeps missing, malformed and closed deployment gates unavailable', () => {
  for (const value of [undefined, null, false, true, '', 'false', 'TRUE'])
    expect(portalServingGateV1(value)?.status).toBe(503);
  expect(portalServingGateV1('true')).toBeNull();
});

it('rejects malformed backend success as unavailable in both existing auth budgets', async () => {
  for (const malformed of [{}, { success: 1 }, { success: 'true' }]) {
    const good = { limit: vi.fn().mockResolvedValue({ success: true }) };
    const bad = { limit: vi.fn().mockResolvedValue(malformed) };
    await expect(portalAuthBurstV1(bad, good)('synthetic')).rejects.toThrow(
      'student-portal-rate-limit-unavailable',
    );
    await expect(portalAuthBurstV1(good, bad)('synthetic')).rejects.toThrow(
      'student-portal-rate-limit-unavailable',
    );
  }
});

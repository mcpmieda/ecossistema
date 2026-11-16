// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { gradebookAfterCommitV1 } from '../../server/gradebook/http/live-after-commit-v1';
import type { Session } from '../../server/auth/session';
import { testEnv } from '../fixtures';
import type { RuntimeEnv } from '../../server/env';
const session: Session = {
  oid: '11111111-1111-4111-8111-111111111111',
  name: 'Synthetic',
  roles: ['ADMINISTRADOR'],
  exp: Math.floor(Date.now() / 1000) + 600,
};

describe('gradebook post-commit delivery hint', () => {
  it('schedules a bounded private hint without blocking the committed response', async () => {
    let finish!: (value: boolean) => void;
    const drainLive = vi.fn<(context: unknown) => Promise<boolean>>(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const work: Promise<unknown>[] = [];
    gradebookAfterCommitV1(
      { ...testEnv, PORTAL_SERVICE: { drainLive } } as RuntimeEnv,
      (pending) => {
        work.push(pending);
      },
    )(session);
    expect(work).toHaveLength(1);
    await Promise.resolve();
    expect(drainLive).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: session.oid,
        tenantId: testEnv.TENANT_ID,
        capability: 'gradebook.persistence.admin',
      }),
    );
    expect(drainLive.mock.calls[0]?.[0]).not.toHaveProperty('actorName');
    finish(true);
    await work[0];
  });
  it('does not send hints for an unauthorized caller or absent old binding', () => {
    const drainLive = vi.fn(),
      waitUntil = vi.fn();
    gradebookAfterCommitV1(
      { ...testEnv, PORTAL_SERVICE: { drainLive } } as RuntimeEnv,
      waitUntil,
    )({ ...session, roles: ['ALUNO'] });
    gradebookAfterCommitV1(testEnv, waitUntil)(session);
    expect(drainLive).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });
  it('keeps committed writes successful on failed notifications', async () => {
    const pending: Promise<unknown>[] = [];
    gradebookAfterCommitV1(
      {
        ...testEnv,
        PORTAL_SERVICE: {
          drainLive: () => {
            throw Error('offline');
          },
        },
      } as RuntimeEnv,
      (work) => pending.push(work),
    )(session);
    await expect(pending[0]).resolves.toBeUndefined();
    expect(() =>
      gradebookAfterCommitV1(
        { ...testEnv, PORTAL_SERVICE: { drainLive: async () => true } } as RuntimeEnv,
        () => {
          throw Error('context-ended');
        },
      )(session),
    ).not.toThrow();
  });
});

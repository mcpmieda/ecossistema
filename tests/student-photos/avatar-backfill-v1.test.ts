// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  backfillAvatarsV1,
  deriveMissingAvatarV1,
} from '../../src/features/student-photos/avatar-backfill-v1';
import { PhotoAdminClientErrorV1 } from '../../src/features/student-photos/admin-client-v1';
import type { PhotoAdminSubjectV1 } from '../../shared/student-photos/admin-http-v1';
import type { PhotoPreviewApprovalV1 } from '../../shared/student-photos/preview-v1';
import {
  backfillIdV1 as id,
  backfillPortsV1 as ports,
  backfillReferenceV1 as reference,
  backfillStateV1 as state,
  backfillSubjectV1 as subject,
} from './avatar-backfill-fixture-v1';

const signal = () => new AbortController().signal;

describe('one student', () => {
  it('saves only the avatar, with the standard framing, against the revision that was read', async () => {
    const { value, spies, dispose } = ports();
    await expect(deriveMissingAvatarV1(subject(1), signal(), value)).resolves.toBe('created');
    expect(spies.portrait).toHaveBeenCalledWith(subject(1), id(800), expect.any(AbortSignal));
    expect(spies.prepare).toHaveBeenCalledWith(
      expect.anything(),
      { x: 0.5, y: 0.16, zoom: 1 },
      0.86,
      expect.any(AbortSignal),
    );
    const command = { requestId: id(1001), expectedRevision: id(800), kind: 'avatar' };
    expect(spies.client.preview).toHaveBeenCalledWith(
      subject(1),
      command,
      { portrait: null, avatar: 86 },
      { portrait: null, avatar: expect.any(Uint8Array) },
      expect.any(AbortSignal),
    );
    expect(spies.client.save).toHaveBeenCalledWith(
      subject(1),
      command,
      { synthetic: 'approval' },
      { portrait: null, avatar: expect.any(Uint8Array) },
      expect.any(AbortSignal),
    );
    expect(dispose).toHaveBeenCalledOnce();
    expect(spies.recover).not.toHaveBeenCalled();
  });

  it.each([
    [{ hasAvatar: true }, 'present'],
    [{ hasPortrait: false }, 'no-portrait'],
    [{ initialized: false, hasPortrait: false, revision: null }, 'no-portrait'],
    [{ pendingRequest: id(600), ownPending: false }, 'pending'],
  ] as const)('writes nothing for %j', async (catalog, outcome) => {
    const { value, spies } = ports(() => catalog);
    await expect(deriveMissingAvatarV1(subject(1), signal(), value)).resolves.toBe(outcome);
    expect(spies.portrait).not.toHaveBeenCalled();
    expect(spies.client.preview).not.toHaveBeenCalled();
    expect(spies.client.save).not.toHaveBeenCalled();
    expect(spies.recover).not.toHaveBeenCalled();
  });

  it('concludes its own unfinished write and one whose answer was not final', async () => {
    const own = ports();
    own.spies.catalog
      .mockResolvedValueOnce({ version: 1, state: 'catalog', traceId: id(700), canWrite: true,
        catalog: state({ pendingRequest: id(601), ownPending: true }) })
      .mockResolvedValueOnce({ version: 1, state: 'catalog', traceId: id(700), canWrite: true,
        catalog: state({ hasAvatar: true }) });
    await expect(deriveMissingAvatarV1(subject(1), signal(), own.value)).resolves.toBe('present');
    expect(own.spies.recover).toHaveBeenCalledWith(subject(1), id(601), expect.any(AbortSignal));
    expect(own.spies.client.save).not.toHaveBeenCalled();

    const unfinished = ports();
    unfinished.spies.client.save.mockImplementation(async (_who, command) => ({
      version: 1, traceId: id(701), state: 'committed', requestId: command.requestId,
      revision: command.requestId, cleanupPending: true,
    }));
    await expect(deriveMissingAvatarV1(subject(2), signal(), unfinished.value)).resolves.toBe('created');
    expect(unfinished.spies.recover).toHaveBeenCalledWith(subject(2), id(1001), expect.any(AbortSignal));

    const open = ports();
    open.spies.client.save.mockImplementation(async (_who, command) => ({
      version: 1, traceId: id(701), state: 'committed', requestId: command.requestId,
      revision: command.requestId, cleanupPending: true,
    }));
    open.spies.recover.mockRejectedValue(new PhotoAdminClientErrorV1('unavailable'));
    await expect(deriveMissingAvatarV1(subject(3), signal(), open.value)).resolves.toBe('pending');
  });

  it('refuses a reader without permission to change photos', async () => {
    const { value, spies } = ports();
    spies.catalog.mockResolvedValue({ version: 1, state: 'catalog', traceId: id(700), canWrite: false,
      catalog: state() });
    await expect(deriveMissingAvatarV1(subject(1), signal(), value)).rejects.toMatchObject({ code: 'forbidden' });
    expect(spies.portrait).not.toHaveBeenCalled();
  });
});

describe('batch', () => {
  it('counts each outcome, keeps going after one failure and never runs more than two at once', async () => {
    let running = 0;
    let most = 0;
    const { value, spies } = ports((who) =>
      reference(who) === id(2) ? { hasAvatar: true } : reference(who) === id(3) ? { hasPortrait: false } : {},
    );
    spies.client.preview.mockImplementation(async (who: PhotoAdminSubjectV1) => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (reference(who) === id(4)) throw new PhotoAdminClientErrorV1('conflict');
      return { approval: {} as PhotoPreviewApprovalV1, images: { portrait: null, avatar: null } };
    });
    const progress = vi.fn();
    const summary = await backfillAvatarsV1([1, 2, 3, 4, 5, 6].map(subject), {
      signal: signal(), ports: value, onProgress: progress,
    });
    expect(summary).toEqual({ created: 3, present: 1, 'no-portrait': 1, pending: 0, failed: 1, done: 6, total: 6 });
    expect(most).toBe(2);
    expect(progress).toHaveBeenCalledTimes(6);
    expect(progress.mock.calls.at(-1)?.[0]).toEqual(summary);
  });

  it('stops at once when the session is lost and writes for nobody else', async () => {
    const { value, spies } = ports();
    spies.catalog.mockImplementation(async (who: PhotoAdminSubjectV1) => {
      if (reference(who) === id(2)) throw new PhotoAdminClientErrorV1('unauthenticated');
      return { version: 1, state: 'catalog', traceId: id(700), canWrite: true, catalog: state() };
    });
    await expect(
      backfillAvatarsV1([1, 2, 3, 4, 5, 6, 7, 8].map(subject), { signal: signal(), ports: value }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(spies.catalog.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('stops when interrupted and reports the interruption', async () => {
    const { value, spies } = ports();
    const controller = new AbortController();
    spies.client.save.mockImplementation(async (_who, command) => {
      controller.abort();
      return { version: 1, traceId: id(701), state: 'committed', requestId: command.requestId,
        revision: command.requestId, cleanupPending: false };
    });
    await expect(
      backfillAvatarsV1([1, 2, 3, 4, 5, 6].map(subject), { signal: controller.signal, ports: value }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(spies.client.save.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

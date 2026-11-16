// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAssessmentNamesEditorV1,
  type AssessmentNamesEditorStateV1,
} from '../../../src/features/gradebook/settings/assessment-names-editor-v1';
import { requestAssessmentNamesV1 } from '../../../src/features/gradebook/settings/assessment-names-client-v1';
import type {
  AssessmentNamesReadyV1,
  AssessmentNamesResponseV1,
} from '../../../shared/gradebook-contracts/settings/assessment-names-v1';
const ready = (
  version = 0,
  names: AssessmentNamesReadyV1['names'] = {},
): AssessmentNamesReadyV1 => ({ contractVersion: 1, state: 'ready', year: 2026, version, names });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('names editor sequencing and trust boundaries', () => {
  it('reports typed and network read failures to the refresh backoff without losing the last snapshot', async () => {
    const send = vi
      .fn<typeof requestAssessmentNamesV1>()
      .mockResolvedValueOnce(ready(2, { '1:1': 'Prova sintética' }))
      .mockResolvedValueOnce({ contractVersion: 1, state: 'unavailable' })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(ready(3, { '1:1': 'Nova prova sintética' }));
    const publish = vi.fn();
    const editor = createAssessmentNamesEditorV1({ year: 2026, send, publish });
    expect(await editor.load()).toBe(true);
    expect(await editor.refresh()).toBe(false);
    expect(await editor.refresh()).toBe(false);
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      base: { version: 2 },
      draft: { '1:1': 'Prova sintética' },
      failure: 'unavailable',
    });
    expect(await editor.refresh()).toBe(true);
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ base: { version: 3 }, failure: null });
    editor.dispose();
  });
  it('loads without saving and coalesces typing into one versioned, trimmed write', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<typeof requestAssessmentNamesV1>()
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce(ready(1, { '1:2': 'Simulado' }));
    const publish = vi.fn(),
      changed = vi.fn();
    const editor = createAssessmentNamesEditorV1({ year: 2026, send, publish, onChanged: changed });
    await editor.load();
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    editor.edit('1:2', 'Si');
    await vi.advanceTimersByTimeAsync(200);
    editor.edit('1:2', ' Simulado ');
    await vi.advanceTimersByTimeAsync(649);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls[1]?.[0]).toEqual({
      contractVersion: 1,
      operation: 'save',
      year: 2026,
      expectedVersion: 0,
      names: { '1:2': 'Simulado' },
    });
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'ready', dirty: false });
    expect(changed).toHaveBeenCalledTimes(1);
    editor.dispose();
  });
  it('serializes editing during a save and uses the returned version for the following write', async () => {
    vi.useFakeTimers();
    const first = deferred<AssessmentNamesResponseV1>();
    const send = vi
      .fn<typeof requestAssessmentNamesV1>()
      .mockResolvedValueOnce(ready())
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(ready(2, { '1:2': 'Segundo' }));
    const publish = vi.fn();
    const editor = createAssessmentNamesEditorV1({ year: 2026, send, publish });
    await editor.load();
    editor.edit('1:2', 'Primeiro');
    const saving = editor.save();
    editor.edit('1:2', 'Segundo');
    await editor.save();
    expect(send).toHaveBeenCalledTimes(2);
    first.resolve(ready(1, { '1:2': 'Primeiro' }));
    await saving;
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      draft: { '1:2': 'Segundo' },
      dirty: true,
    });
    await vi.advanceTimersByTimeAsync(650);
    expect(send.mock.calls[2]?.[0]).toMatchObject({
      expectedVersion: 1,
      names: { '1:2': 'Segundo' },
    });
    expect(publish.mock.calls.at(-1)?.[0].dirty).toBe(false);
    editor.dispose();
  });
  it('never overwrites a local edit with a late background read', async () => {
    vi.useFakeTimers();
    const read = deferred<AssessmentNamesResponseV1>();
    const send = vi
      .fn<typeof requestAssessmentNamesV1>()
      .mockResolvedValueOnce(ready())
      .mockImplementationOnce(() => read.promise)
      .mockResolvedValueOnce(ready(1, { '1:1': 'Local' }));
    const publish = vi.fn();
    const editor = createAssessmentNamesEditorV1({ year: 2026, send, publish });
    await editor.load();
    const loading = editor.refresh();
    editor.edit('1:1', 'Local');
    read.resolve(ready(3, { '1:1': 'Remoto' }));
    await loading;
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      draft: { '1:1': 'Local' },
      base: { version: 0 },
      dirty: true,
    });
    expect(editor.canRefresh()).toBe(false);
    editor.dispose();
  });
  it('preserves a conflict without silent retries/rebase; explicit reload discards it', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<typeof requestAssessmentNamesV1>()
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce({ contractVersion: 1, state: 'conflict' })
      .mockResolvedValueOnce(ready(3, { '1:1': 'Remoto' }));
    const publish = vi.fn();
    const editor = createAssessmentNamesEditorV1({ year: 2026, send, publish });
    await editor.load();
    editor.edit('1:1', 'Local');
    await editor.save();
    await vi.advanceTimersByTimeAsync(5000);
    await editor.save();
    await editor.refresh();
    expect(send).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      failure: 'conflict',
      draft: { '1:1': 'Local' },
      dirty: true,
    });
    await editor.reload();
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      failure: null,
      base: { version: 3 },
      dirty: false,
    });
    editor.dispose();
  });
  it('clears private state on authorization loss and ignores a response after disposal', async () => {
    const send = vi
      .fn<typeof requestAssessmentNamesV1>()
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce({ contractVersion: 1, state: 'not-authorized' });
    let state: AssessmentNamesEditorStateV1 | undefined;
    const lost = vi.fn();
    const editor = createAssessmentNamesEditorV1({
      year: 2026,
      send,
      publish: (v) => {
        state = v;
      },
      onAuthorizationLost: lost,
    });
    await editor.load();
    editor.edit('1:2', 'Privado');
    await editor.save();
    expect(state).toMatchObject({ base: null, draft: {}, dirty: false });
    expect(lost).toHaveBeenCalledOnce();
    editor.edit('1:2', 'Não enviar');
    await editor.save();
    expect(send).toHaveBeenCalledTimes(2);
    editor.dispose();
    const late = deferred<AssessmentNamesResponseV1>(),
      publish = vi.fn();
    const next = createAssessmentNamesEditorV1({ year: 2026, publish, send: () => late.promise });
    const loading = next.load();
    next.dispose();
    const count = publish.mock.calls.length;
    late.resolve(ready());
    await loading;
    expect(publish).toHaveBeenCalledTimes(count);
  });
  it('keeps unsent invalid input and reports failures without automatic write retries', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<typeof requestAssessmentNamesV1>()
      .mockResolvedValueOnce(ready())
      .mockRejectedValueOnce(new Error('offline'));
    const publish = vi.fn();
    const editor = createAssessmentNamesEditorV1({ year: 2026, send, publish });
    await editor.load();
    editor.edit('1:1', 'A'.repeat(81));
    await editor.save();
    expect(send).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls.at(-1)?.[0].failure).toBe('invalid-request');
    editor.edit('1:1', 'Prova');
    await editor.save();
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.at(-1)?.[0]).toMatchObject({
      draft: { '1:1': 'Prova' },
      failure: 'unavailable',
    });
    editor.dispose();
  });
  it('validates year, shape, authorization and no-store transport in the client', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const request = { contractVersion: 1, operation: 'read', year: 2026 } as const;
    fetch.mockResolvedValueOnce(Response.json(ready()));
    expect(await requestAssessmentNamesV1(request)).toEqual(ready());
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
    for (const value of [
      { ...ready(), year: 2025 },
      { ...ready(), extra: 'x' },
      { ...ready(), names: { '1:3': 'illegal' } },
    ]) {
      fetch.mockResolvedValueOnce(Response.json(value));
      expect((await requestAssessmentNamesV1(request)).state).toBe('unavailable');
    }
    fetch.mockResolvedValueOnce(new Response('private', { status: 401 }));
    expect((await requestAssessmentNamesV1(request)).state).toBe('not-authorized');
    fetch.mockResolvedValueOnce(new Response('x'.repeat(17000)));
    expect((await requestAssessmentNamesV1(request)).state).toBe('unavailable');
  });
});

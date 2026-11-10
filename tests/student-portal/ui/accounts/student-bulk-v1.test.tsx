import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentBulkV1 } from '../../../../src/features/student-portal-admin/accounts/student-bulk-v1';
import {
  BULK_CONCURRENCY_V1,
  createStudentBulkControllerV1,
  type BulkStateV1,
} from '../../../../src/features/student-portal-admin/accounts/student-bulk-controller-v1';
import { createPortalAdminClientV1 } from '../../../../src/features/student-portal-admin/shared/admin-client-v1';
import { opIdV1, OP_CLASS_V1, OP_META_V1, opJsonV1 } from '../overview/fixtures-v1';
import { setupOperationsDomV1 } from '../overview/dom-v1';
const query = {
  contractVersion: 1,
  operation: 'bulk-preview',
  action: 'account-reset',
  scope: OP_CLASS_V1,
} as const;
const item = (id: number) => ({
  accountId: opIdV1(id),
  version: 3,
  classId: OP_CLASS_V1.classId,
  name: 'SYNTHETIC BULK ' + id,
  classLabel: 'SYNTHETIC CLASS',
  ineligibility: null,
});
const preview = (ids: number[], total = ids.length, extra = {}) => ({
  ...OP_META_V1,
  state: 'bulk-preview',
  action: query.action,
  scope: OP_CLASS_V1,
  scopeVersion: 17,
  totalCount: total,
  items: ids.map(item),
  proof: 'synthetic_proof_'.repeat(4),
  createdAt: '2026-09-22T12:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
  nextCursor: null,
  ...extra,
});
const committed = () =>
  opJsonV1({ ...OP_META_V1, state: 'committed', operationId: opIdV1(9000), version: 4 });
beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup(fetch: NonNullable<Parameters<typeof createPortalAdminClientV1>[0]>['fetch']) {
  const client = createPortalAdminClientV1({ fetch });
  let state!: BulkStateV1;
  const unauthorized = vi.fn();
  const controller = createStudentBulkControllerV1(
    client,
    (value) => {
      state = value;
    },
    unauthorized,
  );
  return { controller, client, unauthorized, state: () => state };
}
describe('bulk preview and execution', () => {
  it('loads every page beyond 100, keeps page-specific proofs and confirms scope before execution', async () => {
    const bodies: string[] = [];
    const proof2 = 'second_proof_'.repeat(4);
    const s = setup(async (_path, init) => {
      const body = JSON.parse(init.body as string);
      if (body.operation === 'bulk-preview')
        return opJsonV1(
          body.page.cursor
            ? preview([101], 101, { proof: proof2 })
            : preview(
                Array.from({ length: 100 }, (_, i) => i + 1),
                101,
                { nextCursor: 'cursor_'.repeat(6) },
              ),
        );
      bodies.push(init.body as string);
      return committed();
    });
    await s.controller.preview(query);
    expect(s.state().phase).toBe('review');
    expect(s.state().items).toHaveLength(101);
    expect(bodies).toHaveLength(0);
    await s.controller.run();
    expect(bodies).toHaveLength(101);
    expect(JSON.parse(bodies[100]!)).toMatchObject({ proof: proof2, expectedVersion: 3 });
    expect(s.state().items.every((value) => value.result === 'committed')).toBe(true);
    s.controller.dispose();
  });
  it('refuses inconsistent pages before preparing any destructive request', async () => {
    let commands = 0;
    const s = setup(async (_path, init) => {
      const body = JSON.parse(init.body as string);
      if (body.operation !== 'bulk-preview') {
        commands++;
        return committed();
      }
      return opJsonV1(
        body.page.cursor
          ? preview([2], 2, { scopeVersion: 18 })
          : preview([1], 2, { nextCursor: 'cursor_'.repeat(6) }),
      );
    });
    await s.controller.preview(query);
    expect(s.state()).toMatchObject({ phase: 'error', items: [] });
    await s.controller.run();
    expect(commands).toBe(0);
    s.controller.dispose();
  });
  it('shows unavailable accounts without sending commands for them', async () => {
    const bodies: string[] = [];
    const s = setup(async (_path, init) => {
      const body = JSON.parse(init.body as string);
      if (body.operation === 'bulk-preview')
        return opJsonV1(
          preview([1, 2], 2, {
            items: [{ ...item(1), ineligibility: 'recovery-unavailable' }, item(2)],
          }),
        );
      bodies.push(init.body as string);
      return committed();
    });
    await s.controller.preview(query);
    expect(s.state().items.map((entry) => entry.result)).toEqual(['skipped', 'pending']);
    await s.controller.run();
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).accountId).toBe(item(2).accountId);
    expect(s.state().items.map((entry) => entry.result)).toEqual(['skipped', 'committed']);
    s.controller.dispose();
  });
  it('preserves exact intent and bytes after a lost response; retries never regenerate versions or proofs', async () => {
    const bodies: string[] = [];
    let lost = true;
    const s = setup(async (_path, init) => {
      const body = JSON.parse(init.body as string);
      if (body.operation === 'bulk-preview') return opJsonV1(preview([1]));
      bodies.push(init.body as string);
      if (lost) throw new Error('synthetic network loss');
      return committed();
    });
    await s.controller.preview(query);
    await s.controller.run();
    expect(s.state().phase).toBe('unknown');
    await s.controller.preview(query);
    expect(s.state().phase).toBe('unknown');
    lost = false;
    await s.controller.run();
    expect(new Set(bodies).size).toBe(1);
    expect(s.state().phase).toBe('done');
    s.controller.dispose();
  });
  it('runs a bounded batch in parallel; cancel stops unstarted items and resume reuses the same commands', async () => {
    const release: (() => void)[] = [];
    const bodies: string[] = [];
    let active = 0,
      peak = 0;
    const s = setup(async (_path, init) => {
      const body = JSON.parse(init.body as string);
      if (body.operation === 'bulk-preview') return opJsonV1(preview([1, 2, 3, 4, 5, 6, 7, 8]));
      bodies.push(init.body as string);
      peak = Math.max(peak, ++active);
      await new Promise<void>((done) => release.push(done));
      active--;
      return committed();
    });
    await s.controller.preview(query);
    const running = s.controller.run();
    await vi.waitFor(() => expect(bodies).toHaveLength(BULK_CONCURRENCY_V1));
    // Stop scheduling: in-flight writes finish and are kept; the rest wait for "continue".
    s.controller.cancel();
    release.splice(0).forEach((done) => done());
    await running;
    expect(peak).toBe(BULK_CONCURRENCY_V1);
    expect(s.state().phase).toBe('paused');
    expect(s.state().items.filter((entry) => entry.result === 'committed')).toHaveLength(
      BULK_CONCURRENCY_V1,
    );
    const resumed = s.controller.run();
    await vi.waitFor(() => expect(bodies).toHaveLength(8));
    release.splice(0).forEach((done) => done());
    await resumed;
    expect(new Set(bodies).size).toBe(8);
    expect(s.state().phase).toBe('done');
    s.controller.dispose();
  });
  it('writes only the rows selected in the table, or the whole class when none is selected', async () => {
    const written: string[] = [];
    const s = setup(async (_path, init) => {
      const body = JSON.parse(init.body as string);
      if (body.operation === 'bulk-preview') return opJsonV1(preview([1, 2, 3]));
      written.push(body.accountId);
      return committed();
    });
    await s.controller.preview(query, new Set([opIdV1(2)]));
    expect(s.state()).toMatchObject({ phase: 'review', total: 1, targets: 1 });
    await s.controller.run();
    expect(written).toEqual([opIdV1(2)]);
    await s.controller.preview(query, new Set());
    expect(s.state()).toMatchObject({ total: 3, targets: 3 });
    await s.controller.run();
    expect(written.slice(1).sort()).toEqual([opIdV1(1), opIdV1(2), opIdV1(3)].sort());
    s.controller.dispose();
  });
  it('records conflicts per item and clears protected data on lost authorization', async () => {
    let status = 409;
    const s = setup(async (_path, init) =>
      JSON.parse(init.body as string).operation === 'bulk-preview'
        ? opJsonV1(preview([1]))
        : opJsonV1({ ...OP_META_V1, state: status === 409 ? 'conflict' : 'forbidden' }, status),
    );
    await s.controller.preview(query);
    await s.controller.run();
    expect(s.state().items[0]).toMatchObject({ result: 'failed', error: 'conflict' });
    status = 403;
    await s.controller.preview(query);
    await s.controller.run();
    expect(s.state().items).toEqual([]);
    expect(s.unauthorized).toHaveBeenCalledOnce();
    s.controller.dispose();
  });
  it('keeps the longest wait asked for when a later failure brings none', async () => {
    let writes = 0;
    const s = setup(async (_path, init) => {
      if (JSON.parse(init.body as string).operation === 'bulk-preview')
        return opJsonV1(preview([1, 2]));
      if (++writes === 1)
        return opJsonV1({ ...OP_META_V1, state: 'rate-limited' }, 429, { 'Retry-After': '60' });
      await new Promise((done) => setTimeout(done, 5));
      return new Response('<html>busy</html>', {
        status: 503,
        headers: { 'Content-Type': 'text/html' },
      });
    });
    await s.controller.preview(query);
    const started = Date.now();
    await s.controller.run();
    expect(s.state().phase).toBe('unknown');
    expect(s.state().retryAt! - started).toBeGreaterThanOrEqual(55_000);
    s.controller.dispose();
  });
  it('keeps a server error page that asks to wait as unconfirmed, ready to repeat', async () => {
    const s = setup(async (_path, init) =>
      JSON.parse(init.body as string).operation === 'bulk-preview'
        ? opJsonV1(preview([1]))
        : new Response('<html>busy</html>', {
            status: 503,
            headers: { 'Content-Type': 'text/html', 'Retry-After': '30' },
          }),
    );
    await s.controller.preview(query);
    await s.controller.run();
    expect(s.state().phase).toBe('unknown');
    expect(s.state().items[0]).toMatchObject({ result: 'unknown', error: 'invalid-response' });
    s.controller.dispose();
  });
  it('sends nothing once the preview expired, unless a write still needs confirming', async () => {
    let writes = 0;
    let expiresAt = new Date(Date.now() + 300_000).toISOString();
    const s = setup(async (_path, init) => {
      if (JSON.parse(init.body as string).operation === 'bulk-preview')
        return opJsonV1(preview([1, 2], 2, { expiresAt }));
      writes++;
      return committed();
    });
    await s.controller.preview(query);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiresAt) + 1);
    await s.controller.run();
    expect(writes).toBe(0);
    expect(s.state()).toMatchObject({ phase: 'error', error: 'expired' });
    vi.restoreAllMocks();
    // An unconfirmed write is repeated with the same command; the server answers from its receipt.
    let lost = true;
    expiresAt = new Date(Date.now() + 300_000).toISOString();
    const t = setup(async (_path, init) => {
      if (JSON.parse(init.body as string).operation === 'bulk-preview')
        return opJsonV1(preview([1], 1, { expiresAt }));
      writes++;
      if (lost) throw new Error('synthetic network loss');
      return committed();
    });
    await t.controller.preview(query);
    await t.controller.run();
    expect(t.state().phase).toBe('unknown');
    const sent = writes;
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiresAt) + 1);
    lost = false;
    await t.controller.run();
    expect(t.state().phase).toBe('done');
    expect(writes).toBeGreaterThan(sent);
    s.controller.dispose();
    t.controller.dispose();
  });
  it('past the expiry repeats only the unconfirmed write and leaves the pending ones unsent', async () => {
    const sent: string[] = [];
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    let lost = true;
    const ids = Array.from({ length: BULK_CONCURRENCY_V1 + 1 }, (_, i) => i + 1);
    const s = setup(async (_path, init) => {
      const body = JSON.parse(init.body as string);
      if (body.operation === 'bulk-preview')
        return opJsonV1(preview(ids, ids.length, { expiresAt }));
      sent.push(body.accountId);
      if (body.accountId === opIdV1(1) && lost) throw new Error('synthetic network loss');
      await new Promise((done) => setTimeout(done, 5));
      return committed();
    });
    await s.controller.preview(query);
    await s.controller.run();
    expect(s.state().phase).toBe('unknown');
    expect(s.state().items.filter((entry) => entry.result === 'pending')).toHaveLength(1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiresAt) + 1);
    lost = false;
    const before = sent.length;
    await s.controller.run();
    expect(sent.slice(before)).toEqual([opIdV1(1)]);
    expect(s.state().phase).toBe('paused');
    await s.controller.run();
    expect(sent).toHaveLength(before + 1);
    expect(s.state()).toMatchObject({ phase: 'done', error: 'expired' });
    s.controller.dispose();
  });
  it('tells how many accounts were already written when access ends mid-run, without names', async () => {
    let writes = 0;
    const s = setup(async (_path, init) => {
      if (JSON.parse(init.body as string).operation === 'bulk-preview')
        return opJsonV1(preview([1, 2, 3, 4, 5, 6, 7, 8]));
      return ++writes <= 6 ? committed() : opJsonV1({ ...OP_META_V1, state: 'forbidden' }, 403);
    });
    await s.controller.preview(query);
    await s.controller.run();
    expect(s.state().items).toEqual([]);
    expect(s.unauthorized).toHaveBeenCalledWith(expect.anything(), { written: 6, targets: 8 });
    s.controller.dispose();
  });
  it('accepts the phrase typed in lower case, as the field shows it', async () => {
    const s = setup(async (_path, init) =>
      JSON.parse(init.body as string).operation === 'bulk-preview'
        ? opJsonV1(preview([1], 1, { action: 'block' }))
        : committed(),
    );
    render(
      <StudentBulkV1
        client={s.client}
        scope={OP_CLASS_V1}
        scopeLabel="SYNTHETIC CLASS"
        canWrite
        onAuthorizationLost={s.unauthorized}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear acesso' }));
    const input = await screen.findByRole('textbox', {
      name: 'Digite BLOQUEAR ACESSO para confirmar',
    });
    fireEvent.change(input, { target: { value: 'bloquear acesso ' } });
    const confirm = screen.getByRole('button', {
      name: 'Confirmar bloquear acesso',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    s.controller.dispose();
  });
  it('keeps naming the previewed target when the table selection is cleared under the dialog', async () => {
    const s = setup(async (_path, init) =>
      JSON.parse(init.body as string).operation === 'bulk-preview'
        ? opJsonV1(preview([1, 2], 2, { action: 'block' }))
        : committed(),
    );
    const props = {
      client: s.client,
      scope: OP_CLASS_V1,
      scopeLabel: 'SYNTHETIC CLASS',
      canWrite: true,
      onAuthorizationLost: s.unauthorized,
    };
    const view = render(<StudentBulkV1 {...props} selected={new Set([opIdV1(1)])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear acesso' }));
    await screen.findByRole('textbox', { name: 'Digite BLOQUEAR ACESSO para confirmar' });
    expect(screen.getByText('Somente selecionados')).toBeTruthy();
    view.rerender(<StudentBulkV1 {...props} selected={new Set()} />);
    expect(screen.getByText('Somente selecionados')).toBeTruthy();
    expect(screen.queryByText('Turma inteira')).toBeNull();
    s.controller.dispose();
  });
  it('requires the explicit destructive phrase before account reset and displays per-account outcomes', async () => {
    let writes = 0;
    const s = setup(async (_path, init) => {
      if (JSON.parse(init.body as string).operation === 'bulk-preview')
        return opJsonV1(preview([1]));
      writes++;
      return committed();
    });
    render(
      <StrictMode>
        <StudentBulkV1
          client={s.client}
          scope={OP_CLASS_V1}
          scopeLabel="SYNTHETIC CLASS"
          canWrite
          onAuthorizationLost={s.unauthorized}
        />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resetar contas' }));
    expect(screen.queryByRole('button', { name: 'Preparar prévia' })).toBeNull();
    const input = await screen.findByRole('textbox', {
      name: 'Digite RESETAR CONTAS para confirmar',
    });
    const confirm = screen.getByRole('button', {
      name: 'Confirmar resetar contas',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(writes).toBe(0);
    fireEvent.change(input, { target: { value: 'RESETAR CONTAS' } });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(writes).toBe(1);
    // Full-screen dialog: counts and a progress bar instead of a list of names.
    expect(await screen.findByText(/1 concluídos/)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: /Progresso da operação/ })).toBeTruthy();
    expect(screen.queryByText('SYNTHETIC BULK 1 · SYNTHETIC CLASS')).toBeNull();
    s.controller.dispose();
  });
  it('asks the list to read again once when a run with writes stops, never per item', async () => {
    const s = setup(async (_path, init) =>
      JSON.parse(init.body as string).operation === 'bulk-preview'
        ? opJsonV1(preview([1, 2, 3], 3, { action: 'block' }))
        : committed(),
    );
    const onCommitted = vi.fn();
    render(
      <StudentBulkV1
        client={s.client}
        scope={OP_CLASS_V1}
        scopeLabel="SYNTHETIC CLASS"
        canWrite
        onAuthorizationLost={s.unauthorized}
        onCommitted={onCommitted}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear acesso' }));
    const input = await screen.findByRole('textbox', {
      name: 'Digite BLOQUEAR ACESSO para confirmar',
    });
    expect(onCommitted).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'BLOQUEAR ACESSO' } });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Confirmar bloquear acesso' })),
    );
    expect(await screen.findByText(/3 concluídos/)).toBeTruthy();
    expect(onCommitted).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(await screen.findByRole('button', { name: 'Bloquear acesso' })).toBeTruthy();
    expect(onCommitted).toHaveBeenCalledOnce();
    s.controller.dispose();
  });
  it('prepares each clicked action directly and requires its own command before writing', async () => {
    const writes: string[] = [];
    const s = setup(async (_path, init) => {
      const body = JSON.parse(init.body as string);
      if (body.operation === 'bulk-preview')
        return opJsonV1(preview([1], 1, { action: body.action }));
      writes.push(body.action);
      return committed();
    });
    render(
      <StudentBulkV1
        client={s.client}
        scope={OP_CLASS_V1}
        scopeLabel="SYNTHETIC CLASS"
        canWrite
        onAuthorizationLost={s.unauthorized}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mudar QR' }));
    expect(
      await screen.findByRole('textbox', { name: 'Digite MUDAR QR para confirmar' }),
    ).toBeTruthy();
    expect(writes).toHaveLength(0);
    // The dialog owns the screen: leave it before choosing another operation.
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Bloquear acesso' }));
    const input = await screen.findByRole('textbox', {
      name: 'Digite BLOQUEAR ACESSO para confirmar',
    });
    const confirm = screen.getByRole('button', {
      name: 'Confirmar bloquear acesso',
    }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: 'MUDAR QR' } });
    expect(confirm.disabled).toBe(true);
    expect(writes).toHaveLength(0);
    fireEvent.change(input, { target: { value: 'BLOQUEAR ACESSO' } });
    await act(async () => fireEvent.click(confirm));
    expect(writes).toEqual(['block']);
    s.controller.dispose();
  });
});

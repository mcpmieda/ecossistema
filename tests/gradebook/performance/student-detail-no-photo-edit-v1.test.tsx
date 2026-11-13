// @vitest-environment jsdom
import { Drawer } from '@heroui/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PerformanceStudentDetailV2 } from '../../../src/features/gradebook/performance/performance-student-detail-v2';
import { setupOperationsDomV1 } from '../../student-portal/ui/overview/dom-v1';
import { parallelFixture848 } from './parallel-visibility-fixture-848';

beforeEach(setupOperationsDomV1);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Owner request 12/11/2026: the photo is changed only on the record in Painel do Aluno. */
it('the Banco de notas student panel shows the photo without ways to change it', () => {
  const fetch = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetch);
  const { detail } = parallelFixture848({});
  const { container } = render(
    <Drawer.Backdrop isOpen onOpenChange={vi.fn()}>
      <Drawer.Content placement="right">
        <Drawer.Dialog>
          <PerformanceStudentDetailV2 detail={detail} focusPeriod={2} openComponent={vi.fn()} />
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>,
  );
  expect(document.querySelector('.pa-student-avatar')).not.toBeNull();
  // No photo panel at all: its buttons would appear once the photo is read.
  expect(screen.queryByRole('region', { name: 'Foto do aluno' })).toBeNull();
  expect(document.querySelector('.student-photo-panel')).toBeNull();
  for (const name of [
    /trocar foto/i,
    /adicionar foto/i,
    /ajustar avatar/i,
    /^remover/i,
    /tentar de novo/i,
  ])
    expect(screen.queryByRole('button', { name })).toBeNull();
  expect(container.ownerDocument.querySelector('input[type="file"]')).toBeNull();
  vi.unstubAllGlobals();
});

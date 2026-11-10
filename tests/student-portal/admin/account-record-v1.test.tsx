import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountDetailV1 } from '../../../src/features/student-portal-admin/accounts/account-detail-v1';
import {
  accountLinkLabelV1,
  lastAuthenticationLabelV1,
} from '../../../src/features/student-portal-admin/accounts/accounts-values-v1';
import { birthStateLabelV1 } from '../../../src/features/student-portal-admin/accounts/record-birth-v1';
import { LiveRefreshAutomaticV1Provider } from '../../../src/shared/live-data/live-refresh-scope-v1';
import { setupOperationsDomV1 } from '../ui/overview/dom-v1';
import { accountsMockV1 } from '../ui/accounts/fixtures-v1';

vi.mock('../../../src/features/student-photos/student-photo-panel-v1', () => ({
  StudentPhotoPanelV1: () => <span>Foto</span>,
}));

beforeEach(() => {
  setupOperationsDomV1();
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function openRecord(
  slots: Parameters<typeof AccountDetailV1>[0]['slots'] = {
    credentials: () => <span>QR</span>,
    sessions: () => <span>Sessões</span>,
  },
) {
  const mock = accountsMockV1();
  render(
    <LiveRefreshAutomaticV1Provider enabled={false}>
      <AccountDetailV1
        {...mock.props}
        accountId={mock.accounts[0]!.accountId}
        parentScope={mock.props.scope}
        onClose={vi.fn()}
        onChanged={vi.fn()}
        slots={slots}
      />
    </LiveRefreshAutomaticV1Provider>,
  );
  for (let step = 0; step < 5; step++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  screen.getByRole('group', { name: 'Ações de acesso' });
}

it('ficha: ações na ordem pedida, Redefinir senha verde e nenhuma vermelha (10/11/2026)', async () => {
  await openRecord();
  const group = screen.getByRole('group', { name: 'Ações de acesso' });
  const labels = [...group.querySelectorAll('button')].map((button) => button.textContent);
  expect(labels).toEqual([
    'Redefinir senha',
    expect.stringMatching(/^(Bloquear|Desbloquear) acesso$/),
    'Resetar conta',
  ]);
  expect(group.querySelector('button')!.className).toContain('pa-action-success');
  // Opening a record never shows the QR by itself: that read is a recorded reprint.
  expect(screen.getByRole('tab', { name: 'Sessões' }).getAttribute('aria-selected')).toBe('true');
  expect(group.querySelector('.button--danger')).toBeNull();
});

it('ficha: vínculo e regra no resumo, sem aba Nascimento', async () => {
  await openRecord();
  expect(screen.getByText('Vínculo')).toBeTruthy();
  expect(screen.getByText('Regra de acesso')).toBeTruthy();
  expect(screen.queryByText('Origem do acesso')).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Nascimento' })).toBeNull();
  // The line sits under the name; its values are covered by record-birth-v1.test.tsx.
  expect(screen.getByText(/^Nascimento/).closest('.pa-account-identity')).toBeTruthy();
});

it('textos curtos da ficha', () => {
  expect(lastAuthenticationLabelV1(null)).toBe('Nenhum em 12 meses');
  expect(birthStateLabelV1({ year: null, confirmation: null } as never)).toBe('Aguardando Relatório');
  expect(birthStateLabelV1({ year: 2013, confirmation: 'confirmed' } as never)).toBe('Confirmado');
  expect(accountLinkLabelV1({ linkClosed: true } as never)).toBe('Encerrado no Portal');
});

it('ficha sem aba de QR abre na primeira aba que existe', async () => {
  await openRecord({ sessions: () => <span>Painel de sessões</span> });
  expect(screen.getByRole('tab', { name: 'Sessões' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByText('Painel de sessões')).toBeTruthy();
});

it('"Mudar QR" fica na aba QR code e abre a mesma confirmação da ficha', async () => {
  await openRecord({
    credentials: (context) => (
      <button type="button" disabled={context.regenerateQr.disabled} onClick={context.regenerateQr.open}>
        Mudar QR
      </button>
    ),
  });
  const group = screen.getByRole('group', { name: 'Ações de acesso' });
  expect(group.textContent).not.toContain('Mudar QR');
  act(() => screen.getByRole('button', { name: 'Mudar QR' }).click());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole('alertdialog').textContent).toContain('Mudar QR');
});

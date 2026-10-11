import { createElement, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountFilterTagsV1,
  ACCOUNT_STATE_OPTIONS_V1,
  matchesAccountFiltersV1,
} from '../../../src/features/student-portal-admin/accounts/account-filters-v1';
import { qrFilenameV1 } from '../../../src/features/student-portal-admin/credentials/qr-filename-v1';
import {
  portalSectionFromHash,
  studentPortalHref,
} from '../../../src/platform/student-portal-module';
import { qrMockV1 } from './credentials/fixtures-v1';
afterEach(cleanup);
describe('reconstruction #1101 pure and accessibility contracts', () => {
  it('combines alternatives within a filter and intersects the two filter groups', () => {
    const [account] = qrMockV1().accounts;
    expect(matchesAccountFiltersV1(account!, new Set(), new Set())).toBe(true);
    expect(
      matchesAccountFiltersV1(
        account!,
        new Set(['active', 'pending-activation']),
        new Set(['unblocked']),
      ),
    ).toBe(true);
    expect(
      matchesAccountFiltersV1(account!, new Set(['active', 'reset-required']), new Set()),
    ).toBe(false);
    expect(
      matchesAccountFiltersV1(account!, new Set(['pending-activation']), new Set(['blocked'])),
    ).toBe(false);
    expect(matchesAccountFiltersV1(account!, new Set(), new Set(['blocked', 'unblocked']))).toBe(
      true,
    );
  });
  it('renders genuine multi-select tags and supports independent toggles', () => {
    function Tags() {
      const [keys, setKeys] = useState(new Set<string>());
      return createElement(AccountFilterTagsV1, {
        label: 'Situação',
        selected: keys,
        onChange: setKeys,
        options: ACCOUNT_STATE_OPTIONS_V1,
      });
    }
    render(createElement(Tags));
    const active = screen.getByRole('row', { name: 'Ativa' }),
      pending = screen.getByRole('row', { name: 'Primeiro acesso' });
    fireEvent.click(active);
    fireEvent.click(pending);
    expect(active.getAttribute('aria-selected')).toBe('true');
    expect(pending.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(active);
    expect(active.getAttribute('aria-selected')).toBe('false');
    expect(pending.getAttribute('aria-selected')).toBe('true');
  });
  it('uses legible safe uppercase filenames without control characters or path separators', () => {
    expect(qrFilenameV1('6º ANO A', 'pdf')).toBe('QR DO 6º ANO A.pdf');
    expect(qrFilenameV1('teste_a/b\\c\u0000.', 'png')).toBe('QR DO TESTE A B C.png');
    expect(qrFilenameV1(undefined, 'pdf')).toBe('QR DE ACESSO.pdf');
  });
  it('redirects the existing birth/publication query-string routes', () => {
    expect(portalSectionFromHash('#/painel-do-aluno?area=birth')).toBe('credentials');
    expect(portalSectionFromHash('#/painel-do-aluno?area=publication')).toBe('audit');
    expect(studentPortalHref('birth')).toBe(studentPortalHref('credentials'));
    expect(studentPortalHref('publication')).toBe(studentPortalHref('audit'));
  });
});

import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PolicyLayoutV1 } from '../../../../src/features/student-portal-admin/settings/policy-layout-v1';
import { useLiveRefreshV1 } from '../../../../src/shared/live-data/use-live-refresh-v1';
import { notifyLiveChangeV1 } from '../../../../src/shared/live-data/live-refresh-v1';
import { setupOperationsDomV1 } from '../overview/dom-v1';
import { StudentSettingsV1 } from '../../../../src/features/student-portal-admin/settings/student-settings-v1';
import { AccountDetailV1 } from '../../../../src/features/student-portal-admin/accounts/account-detail-v1';
import { StudentAccountsV1 } from '../../../../src/features/student-portal-admin/accounts/student-accounts-v1';
import { accountsMockV1, accountJsonV1, ACCOUNT_META_V1 } from '../accounts/fixtures-v1';
import { settingsFixtureV1 } from './fixtures-v1';
import { createPortalAdminClientV1 } from '../../../../src/features/student-portal-admin/shared/admin-client-v1';

const customizationRead = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/features/student-portal-admin/settings/customized-settings-v1', () => ({
  CustomizedSettingsV1: () => <PublicationProbe read={customizationRead} />,
}));
vi.mock('../../../../src/features/student-photos/student-photo-panel-v1', () => ({
  StudentPhotoPanelV1: () => null,
}));

beforeEach(() => {
  setupOperationsDomV1();
  customizationRead.mockClear();
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});

it('loads customizations only on the first visit to their tab and pauses them on another tab', async () => {
  const mock = accountsMockV1();
  const settings = settingsFixtureV1();
  const client = createPortalAdminClientV1({
    fetch: async () => accountJsonV1({ ...ACCOUNT_META_V1, state: 'settings', settings }),
  });
  render(
    <StudentSettingsV1
      client={client}
      reader={mock.props.reader}
      scope={settings.scope}
      canWrite
      area="policies"
      onOpenCustomization={vi.fn()}
    />,
  );
  await advance(0);
  await advance(62_000);
  expect(customizationRead).not.toHaveBeenCalled();
  const trigger = screen.getByRole('tab', { name: 'Políticas personalizadas' });
  fireEvent.click(trigger);
  expect(customizationRead).toHaveBeenCalledTimes(1);
  await advance(31_100);
  expect(customizationRead).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('tab', { name: 'Acesso' }));
  act(() => notifyLiveChangeV1('portal', { broadcast: false }));
  await advance(62_000);
  expect(customizationRead).toHaveBeenCalledTimes(2);
  fireEvent.click(trigger);
  await advance(1_500);
  expect(customizationRead).toHaveBeenCalledTimes(3);
});

it('retains visited account slots but revalidates only the visible slot', async () => {
  const mock = accountsMockV1();
  const birth = vi.fn(),
    policies = vi.fn();
  render(
    <AccountDetailV1
      {...mock.props}
      accountId={mock.accounts[0]!.accountId}
      parentScope={mock.props.scope}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      slots={{
        sessions: () => <PublicationProbe read={birth} />,
        settings: () => <PublicationProbe read={policies} />,
      }}
    />,
  );
  await advance(0);
  expect(birth).toHaveBeenCalledTimes(1);
  expect(policies).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: 'Políticas' }));
  expect(policies).toHaveBeenCalledTimes(1);
  await advance(31_100);
  expect(birth).toHaveBeenCalledTimes(1);
  expect(policies).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('tab', { name: 'Sessões' }));
  await advance(1_500);
  expect(birth).toHaveBeenCalledTimes(2);
  expect(policies).toHaveBeenCalledTimes(2);
});

it('pauses the account list behind its drawer and refreshes it exactly once on return', async () => {
  const mock = accountsMockV1({ count: 1 });
  render(<StudentAccountsV1 {...mock.props} />);
  await advance(0);
  const listReads = () => mock.queries.filter((query) => query.scope.kind === 'school').length;
  expect(listReads()).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Abrir ficha de SYNTHETIC ACCOUNT 001' }));
  await advance(0);
  await advance(62_000);
  expect(listReads()).toBe(1);
  expect(mock.queries.filter((query) => query.scope.kind === 'account').length).toBeGreaterThan(1);
  fireEvent.click(screen.getByRole('button', { name: 'Fechar ficha' }));
  await advance(1_500);
  expect(listReads()).toBe(2);
  await advance(1_500);
  expect(listReads()).toBe(2);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function PublicationProbe({ read }: { read: () => void }) {
  useEffect(read, [read]);
  useLiveRefreshV1(read, { domains: ['portal'] });
  return <span>Publicação sintética</span>;
}
const advance = async (milliseconds: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
};

it('does not load publication until visited and pauses retained hidden reads including invalidations', async () => {
  const read = vi.fn();
  render(
    <PolicyLayoutV1
      disabled={false}
      field={(name) => <span key={name}>{name}</span>}
      grades={<PublicationProbe read={read} />}
    />,
  );
  await advance(62_000);
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: 'Notas' }));
  expect(read).toHaveBeenCalledTimes(1);
  await advance(31_100);
  expect(read).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('tab', { name: 'Acesso' }));
  act(() => notifyLiveChangeV1('portal', { broadcast: false }));
  await advance(62_000);
  expect(read).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('tab', { name: 'Notas' }));
  await advance(1_500);
  expect(read).toHaveBeenCalledTimes(3);
});

import { useCallback, useRef } from 'react';
import type { AdminAccountReadV2 } from '../../../../shared/student-portal-contracts/admin-read-v2';
import type { PortalAdminClientV1 } from '../shared/admin-client-v1';
import type { PortalAdminReadClientV2 } from './accounts-client-v2';
import { useAccountsReadV1 } from './accounts-read-v1';
import { readBirthPageV1, type BirthValueV1 } from '../birth-year/birth-read-v1';

/** How the year stands: confirmed by the Relatório, legacy, or still waiting for it. */
export function birthStateLabelV1(birth: BirthValueV1): string {
  if (birth.confirmation === 'confirmed') return 'Confirmado';
  return birth.year ? 'Legado não confirmado' : 'Aguardando Relatório';
}

/** The record's birth year, one line under the name (owner request 10/11/2026: no tab). */
export function RecordBirthV1({
  client,
  reader,
  account,
  scopeVersion,
}: Readonly<{
  client: PortalAdminClientV1;
  reader: PortalAdminReadClientV2;
  account: AdminAccountReadV2;
  scopeVersion: number;
}>) {
  // The latest account is reused as the read's snapshot; only its version starts a new read.
  const latest = useRef(account);
  latest.current = account;
  const load = useCallback(
    async (signal: AbortSignal) => {
      const current = latest.current;
      const page = await readBirthPageV1(
        client,
        reader,
        { kind: 'account', academicYear: 2026, accountId: current.accountId },
        undefined,
        signal,
        { account: current, scopeVersion },
      );
      return page.rows[0]?.birth ?? null;
    },
    // The account version changes after every confirmed action: the year is read again.
    [client, reader, account.accountId, account.version, scopeVersion],
  );
  const read = useAccountsReadV1(load);
  let text = 'Nascimento: …';
  if (read.state.state === 'error') text = 'Nascimento indisponível';
  else if (read.state.state === 'ready') {
    const birth = read.state.data;
    text = birth
      ? `Nascimento: ${birth.year ?? '—'} · ${birthStateLabelV1(birth)}`
      : 'Nascimento: —';
  }
  return <span className="pa-record-birth">{text}</span>;
}

import { useCallback, useState } from 'react';
import {
  StudentSettingsV1,
  type PublicationSlotsV1,
  type StudentSettingsPropsV1,
} from './student-settings-v1';
import { PersonalizedPublicationV1 } from '../publication/personalized-publication-v1';
import type { PortalAdminReadClientV2 } from '../accounts/accounts-client-v2';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import { PolicyScopeV1 } from './policy-scope-v1';
import { useAccountsReadV1 } from '../accounts/accounts-read-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { AccountsErrorV1 } from '../accounts/accounts-presentation-v1';
import { LiveReadNoticeV1 } from '../../../shared/live-data/live-read-notice-v1';
import { settingsScopeLabelV1 } from './settings-values-v1';

function ShiftNoticeV1({
  reader,
  shift,
}: Readonly<{
  reader: PortalAdminReadClientV2;
  shift: 'MATUTINO' | 'VESPERTINO' | 'NOTURNO';
}>) {
  const load = useCallback(
    async (signal: AbortSignal) => {
      const result = await reader.query(
        {
          contractVersion: 2,
          operation: 'shifts-read',
          scope: { kind: 'school', academicYear: 2026 },
          page: { limit: 100 },
        },
        signal,
      );
      if (result.state !== 'shifts-read') throw new PortalClientErrorV1('invalid-response');
      return result.items.find((item) => item.shift === shift) ?? null;
    },
    [reader, shift],
  );
  const read = useAccountsReadV1(load);
  if (read.state.state === 'error')
    return (
      <AccountsErrorV1 error={read.state.error} canReload={read.canReload} onReload={read.reload} />
    );
  const data = read.state.state === 'ready' ? read.state.data : null;
  const suspended =
    data?.classes.filter((item) => item.ownFields.some((field) => data.ownFields.includes(field)))
      .length ?? 0;
  const suspendedText =
    suspended === 1 ? 'turma tem regras suspensas' : 'turmas têm regras suspensas';
  return (
    <>
      <LiveReadNoticeV1 failed={Boolean(read.refreshError)} />
      {suspended > 0
        ? `${suspended} ${suspendedText} pelo turno. `
        : 'As regras do turno prevalecem sobre as turmas. '}
      Personalizações de alunos continuam valendo.
    </>
  );
}
/** The publication list of a class or the school, with the Notas tab's slots placed in it. */
function personalizedPublicationV1(
  props: StudentSettingsPropsV1 & { reader: PortalAdminReadClientV2 },
  scope: ScopeV1,
) {
  return (slots: PublicationSlotsV1) => (
    <PersonalizedPublicationV1
      client={props.client}
      reader={props.reader}
      scope={scope}
      scopeLabel={props.scopeLabel}
      canWrite={props.canWrite}
      embedded
      {...slots}
    />
  );
}

export function StudentPoliciesV1(
  props: StudentSettingsPropsV1 & { reader: PortalAdminReadClientV2 },
) {
  const [revision, setRevision] = useState(0);
  const committed = useCallback(() => {
    setRevision((value) => value + 1);
    props.onCommitted?.();
  }, [props.onCommitted]);
  const scope = props.scope;
  return (
    <section className="pa-policies" aria-label="Políticas do Portal">
      <PolicyScopeV1
        scope={scope}
        label={props.scopeLabel ?? settingsScopeLabelV1(scope)}
        note={
          scope.kind === 'shift' ? (
            <ShiftNoticeV1 key={revision} reader={props.reader} shift={scope.shift} />
          ) : undefined
        }
      />
      <StudentSettingsV1
        {...props}
        onCommitted={committed}
        area="policies"
        publication={scope.kind === 'shift' ? undefined : personalizedPublicationV1(props, scope)}
      />
    </section>
  );
}

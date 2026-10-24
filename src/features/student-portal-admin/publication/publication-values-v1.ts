import type {
  AdminCommandV1,
  AdminResponseV1,
} from '../../../../shared/student-portal-contracts/admin-v1';
import type { EffectiveSettingsV1 } from '../../../../shared/student-portal-contracts/policy-v1';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';
import { PERIODS_V1, settingsScopeKeyV1 } from '../settings/settings-values-v1';

export type PublicationItemV1 = Extract<AdminResponseV1, { state: 'publication' }>['items'][number];
export type PublicationCommandV1 = Extract<
  AdminCommandV1,
  { operation: 'publish' | 'publish-update' | 'unpublish' }
>;
export interface PublicationSnapshotV1 {
  items: PublicationItemV1[];
  settings: EffectiveSettingsV1;
}
export const PUBLICATION_LABELS_V1 = {
  'no-data': 'Sem notas no Banco',
  available: 'Pronta para publicar',
  published: 'Publicada',
  'update-pending': 'Há notas novas no Banco',
} as const;
export function publicationSnapshotV1(
  scope: ScopeV1,
  publication: AdminResponseV1,
  policy: AdminResponseV1,
): PublicationSnapshotV1 {
  if (
    publication.state !== 'publication' ||
    policy.state !== 'settings' ||
    settingsScopeKeyV1(policy.settings.scope) !== settingsScopeKeyV1(scope) ||
    publication.items.length !== PERIODS_V1.length ||
    new Set(publication.items.map((item) => item.period)).size !== PERIODS_V1.length ||
    new Set(publication.items.map((item) => item.version)).size !== 1
  )
    throw new PortalClientErrorV1('invalid-response');
  return {
    items: PERIODS_V1.map((period) => publication.items.find((item) => item.period === period)!),
    settings: policy.settings,
  };
}
export function publicationCommandV1(
  scope: ScopeV1,
  item: PublicationItemV1,
  operation: PublicationCommandV1['operation'],
  idempotencyKey: string,
): PublicationCommandV1 {
  const common = {
    contractVersion: 1 as const,
    scope,
    period: item.period,
    expectedVersion: item.version,
    idempotencyKey,
  };
  if (operation === 'unpublish') {
    if (item.publishedRevision === null) throw new PortalClientErrorV1('invalid-request');
    return { ...common, operation, confirmed: true };
  }
  if (
    item.state === 'no-data' ||
    item.availableRevision === null ||
    (operation === 'publish-update' && item.publishedRevision === null)
  )
    throw new PortalClientErrorV1('invalid-request');
  return { ...common, operation, targetDataVersion: item.availableRevision };
}
/** An aggregated revision can represent only some profiles; it is not a completion count. */
export function publicationObservationV1(
  scope: ScopeV1,
  command: PublicationCommandV1,
  items: PublicationItemV1[],
): 'waiting' | 'confirmed' | 'reported' {
  const item = items.find((item) => item.period === command.period);
  const observed =
    command.operation === 'unpublish'
      ? (item?.state === 'available' || item?.state === 'no-data') &&
        item.publishedRevision === null
      : (item?.state === 'published' || item?.state === 'update-pending') &&
        item.publishedRevision === command.targetDataVersion;
  if (!observed) {
    return 'waiting';
  }
  if (scope.kind === 'account') {
    return 'confirmed';
  }
  return 'reported';
}
export function disclosureAtV1(settings: EffectiveSettingsV1, period: PublicationItemV1['period']) {
  const disclosure = settings.value.calendar.disclosure;
  // Aba Notas agendas have no single "Liberar a partir de" date.
  if (disclosure.mode === 'agenda') return null;
  if (disclosure.mode === 'single') {
    if (disclosure.periods.includes(period)) {
      return disclosure.at;
    }
    return null;
  }
  return disclosure.at[period];
}
/** Describes configured exclusions only; eligibility and access remain server decisions. */
export function publicationRestrictionV1(
  settings: EffectiveSettingsV1,
  period: PublicationItemV1['period'],
): 'period-disabled' | 'outside-single-schedule' | null {
  const disclosure = settings.value.calendar.disclosure;
  if (disclosure.mode === 'agenda') return null;
  if (!settings.value.allowedPeriods.includes(period)) return 'period-disabled';
  if (disclosure.mode === 'single' && !disclosure.periods.includes(period))
    return 'outside-single-schedule';
  return null;
}

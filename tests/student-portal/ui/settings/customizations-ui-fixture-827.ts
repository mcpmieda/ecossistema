import type { AdminCommandV1, AdminQueryV1 } from '../../../../shared/student-portal-contracts/admin-v1';
import type { AdminReadQueryV2 } from '../../../../shared/student-portal-contracts/admin-read-v2';
import type { ScopeV1 } from '../../../../shared/student-portal-contracts/core-v1';
import { customizationsResponseV1, type PublicationContextItemV1 } from '../../../../shared/student-portal-contracts/customizations-v1';
import { initialPolicyDefaultsV1 } from '../../../../server/student-portal/policies/defaults-v1';
import type { PortalFetchV1 } from '../../../../src/features/student-portal/shared/transport-v1';
import { accountFixtureV1, accountIdV1, accountJsonV1, accountPageV1, emptyReconciliationReadV1, ACCOUNT_CLASS_V1, ACCOUNT_SCHOOL_V1 } from '../accounts/fixtures-v1';

const periods = ['T1', 'T2', 'T3', 'REC1', 'REC2', 'REC3'] as const;
const revision = 'a'.repeat(32) + ':1';
const at = '2026-09-16T12:00:00Z';
const key = (scope: ScopeV1) => scope.kind === 'school' ? 'school:2026' : scope.kind === 'class'
  ? `class:2026:${scope.classId}` : `account:2026:${scope.accountId}`;
/** Synthetic HTTP boundaries, with real transports, schemas, event invalidation and UI. */
export function customizationsUiFixture827(count = 1) {
  const accounts = Array.from({ length: count }, (_, index) => accountFixtureV1(index + 1));
  const state = {
    individual: true, classExtra: false, extraSetting: false, blocked: false,
    version: 7, identity: 'synthetic-customizations-827', write: true, denied: false,
    reject: null as null | 'network' | 'conflict',
  };
  const queries: (AdminReadQueryV2 | AdminQueryV1)[] = [];
  const commands: AdminCommandV1[] = [];
  const bodies: string[] = [];
  function contexts(scope: ScopeV1): PublicationContextItemV1[] {
    return periods.map((period) => {
      const school = { source: period === 'T1' ? ACCOUNT_SCHOOL_V1 : null,
        revision: period === 'T1' ? revision : null, version: period === 'T1' ? 2 : null };
      const inherited = scope.kind === 'account' && state.classExtra && period === 'T3'
        ? { source: ACCOUNT_CLASS_V1, revision, version: 4 } : school;
      const own = (scope.kind === 'account' && state.individual && period === 'T2') ||
        (scope.kind === 'class' && state.classExtra && period === 'T3');
      return { period, school, inherited, current: own ? { source: scope, revision, version: 6 } : inherited,
        customized: own, ownVersion: own ? 6 : null };
    });
  }
  function row(scope: Exclude<ScopeV1, { kind: 'school' }>) {
    const account = scope.kind === 'account' ? accounts.find((item) => item.accountId === scope.accountId)! : null;
    const options = scope.kind === 'account' && state.extraSetting;
    return {
      id: key(scope), scope, label: account?.name ?? 'SYNTHETIC CLASS A', classLabel: 'SYNTHETIC CLASS A',
      classId: 753001, accountState: account?.state ?? null, accountVersion: account?.version ?? null,
      settingsVersion: 11, publicationVersion: state.version,
      value: options ? { showPartials: false } : null,
      inheritedValue: options ? { showPartials: true } : null, schoolValue: options ? { showPartials: true } : null,
      blocked: scope.kind === 'account' && state.blocked,
      publications: contexts(scope).filter((item) => item.customized), updatedAt: at,
    };
  }
  const fetcher: PortalFetchV1 = async (path, init) => {
    if (path === '/api/me') return accountJsonV1({
      authenticated: true, identityKey: state.identity, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      capabilities: ['platform.settings.read', ...(state.write ? ['platform.settings.write'] : [])],
    });
    if (state.denied) return accountJsonV1({ contractVersion: 1, requestId: accountIdV1(9000), state: 'forbidden' }, 403);
    const input = JSON.parse(String(init.body)) as AdminQueryV1 | AdminReadQueryV2 | AdminCommandV1;
    if (path === '/api/student-reconciliation/v1')
      return accountJsonV1(emptyReconciliationReadV1(input.operation));
    const meta = { contractVersion: 1, requestId: accountIdV1(9000) };
    if ('expectedVersion' in input) {
      commands.push(input);
      bodies.push(String(init.body));
      if (state.reject === 'network') throw new TypeError('SYNTHETIC response lost');
      if (state.reject === 'conflict') return accountJsonV1({ ...meta, state: 'conflict' }, 409);
      if (input.operation === 'publication-inherit') {
        if (input.scope.kind === 'account') state.individual = false;
        else state.classExtra = false;
      } else if (input.operation === 'settings-inherit') state.extraSetting = false;
      else if (input.operation === 'block') state.blocked = input.blocked;
      else if (input.operation === 'publish' && input.scope.kind === 'account' && input.period === 'T2') state.individual = true;
      else throw new Error('Unexpected synthetic customization command: ' + input.operation);
      state.version++;
      return accountJsonV1({ ...meta, state: 'committed', operationId: accountIdV1(9001), version: state.version });
    }
    queries.push(input);
    if (input.operation === 'accounts-read') return accountJsonV1(accountPageV1(accounts.filter((item) =>
      input.scope.kind !== 'account' || item.accountId === input.scope.accountId)));
    if (input.operation === 'customizations-read') {
      const owners = [...accounts.map((item) => row({ kind: 'account', academicYear: 2026, accountId: item.accountId })), row(ACCOUNT_CLASS_V1)]
        .filter((item) => item.value || item.blocked || item.publications.length)
        .filter((item) => input.scope.kind === 'school' || (input.scope.kind === 'class'
          ? item.classId === input.scope.classId : item.id === key(input.scope)))
        .filter((item) => !input.nameSearch || (item.label + ' ' + item.classLabel).toLowerCase().includes(input.nameSearch.toLowerCase()));
      const offset = input.page.cursor ? 100 : 0;
      return accountJsonV1(customizationsResponseV1.parse({ ...meta, contractVersion: 2, state: 'customizations-read',
        observedAt: at, scope: input.scope, publicationVersion: state.version, items: owners.slice(offset, offset + 100),
        nextCursor: owners.length > offset + 100 ? 'n'.repeat(80) : null,
        context: input.scope.kind === 'school' ? null : { scope: input.scope, resolved: true, publications: contexts(input.scope) },
      }));
    }
    if (input.operation === 'settings') {
      const value = { ...initialPolicyDefaultsV1(), accessEnabled: true, showPartials: true, allowedPeriods: [...periods] };
      if (input.scope.kind === 'account' && state.extraSetting) value.showPartials = false;
      return accountJsonV1({ ...meta, state: 'settings', settings: { scope: input.scope, version: 11, value,
        sources: Object.fromEntries(Object.keys(value).map((field) => [field,
          field === 'showPartials' && input.scope.kind === 'account' && state.extraSetting ? input.scope : ACCOUNT_SCHOOL_V1])),
      } });
    }
    if (input.scope.kind === 'shift') return accountJsonV1({ ...meta, state: 'invalid-request' }, 400);
    if (input.operation === 'publication') return accountJsonV1({ ...meta, state: 'publication',
      items: contexts(input.scope).map((item) => ({ period: item.period,
        state: item.current.revision ? 'published' : 'available',
        availableRevision: revision, publishedRevision: item.current.revision, version: state.version })),
    });
    if (input.operation === 'birth-years') return accountJsonV1({ ...meta, state: 'birth-years', scopeVersion: 4,
      items: accounts.filter((item) => input.scope.kind !== 'account' || item.accountId === input.scope.accountId)
        .map((item) => ({ accountId: item.accountId, accountVersion: 9, year: null, confirmation: null, version: 0 })), nextCursor: null });
    throw new Error('Unexpected synthetic customization query: ' + input.operation);
  };
  const catalog = { contractVersion: 2, state: 'ready', operation: 'search',
    context: { year: 2026, minimumApprovalMilli: 60000, maxCouncilComponents: 2 },
    items: [{ entity: { kind: 'class-group', id: 753001, label: 'SYNTHETIC CLASS A' }, description: null }], nextOffset: null };
  return { state, fetcher, catalog, accounts, queries, commands, bodies, row };
}

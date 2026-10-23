import type { PortalFetchV1 } from '../features/student-portal/shared/transport-v1';
import type { AdminQueryV1 } from '../../shared/student-portal-contracts/admin-v1';
import type { AdminReadQueryV2 } from '../../shared/student-portal-contracts/admin-read-v2';
import {
  operationsMockV1,
  opIdV1,
  opJsonV1,
} from '../../tests/student-portal/ui/overview/fixtures-v1';
import { settingsFixtureV1 } from '../../tests/student-portal/ui/settings/fixtures-v1';
import {
  effectiveSettingsV1,
  type EffectiveSettingsV1,
} from '../../shared/student-portal-contracts/policy-v1';
import type { PolicyScopeV1, ScopeV1 } from '../../shared/student-portal-contracts/core-v1';

/*
 * Settings the preview can save: the school value plus class/student overrides, resolved field by
 * field like the server. The school starts like production on 27/09/2026 — switch on and the old
 * Calendário access window — so the access card shows how it converts into agendamentos.
 */
const previewSchool = (() => {
  const base = settingsFixtureV1().value;
  return {
    ...base,
    accessEnabled: true,
    calendar: {
      ...base.calendar,
      yearStartsAt: '2026-02-23T03:00:00Z',
      yearEndsAt: '2026-12-18T21:00:00Z',
      accessStartsAt: new Date(Date.now() + 2 * 3600_000).toISOString().replace(/\.\d{3}Z$/u, 'Z'),
    },
  } as EffectiveSettingsV1['value'];
})();
const previewOverrides = new Map<string, Partial<EffectiveSettingsV1['value']>>();
let previewSettingsVersion = 7;
const previewScopeKey = (scope: PolicyScopeV1) =>
  scope.kind === 'school'
    ? 'school'
    : scope.kind === 'class'
      ? `class:${scope.classId}`
      : scope.kind === 'shift'
        ? `shift:${scope.shift}`
        : `account:${scope.accountId}`;
function previewSettingsV1(scope: PolicyScopeV1): EffectiveSettingsV1 {
  const value: Record<string, unknown> = { ...previewSchool };
  const sources: Record<string, PolicyScopeV1> = Object.fromEntries(
    Object.keys(previewSchool).map((key) => [key, { kind: 'school', academicYear: 2026 }]),
  );
  const classId =
    scope.kind === 'class'
      ? scope.classId
      : scope.kind === 'account'
        ? mock.accounts.find((item) => item.accountId === scope.accountId)?.classId
        : undefined;
  const classroom = classes.find((item) => item.id === classId);
  const chain: PolicyScopeV1[] = [
    ...(classroom
      ? [{ kind: 'class' as const, academicYear: 2026 as const, classId: classroom.id }]
      : []),
    ...(classroom?.shift
      ? [{ kind: 'shift' as const, academicYear: 2026 as const, shift: classroom.shift }]
      : []),
    ...(scope.kind === 'account' || scope.kind === 'shift' ? [scope] : []),
  ];
  for (const level of chain)
    for (const [key, override] of Object.entries(
      previewOverrides.get(previewScopeKey(level)) ?? {},
    )) {
      value[key] = override;
      sources[key] = level;
    }
  return effectiveSettingsV1.parse({ scope, version: previewSettingsVersion, value, sources });
}
import { publicationFixtureV1 } from '../../tests/student-portal/ui/publication/fixtures-v1';
import {
  PHOTO_AVATAR_BATCH_PATH_V1,
  PHOTO_AVATAR_BATCH_TYPE_V1,
  encodePhotoAvatarBatchV1,
} from '../../shared/student-photos/avatar-batch-v1';
import { photoImageUrlV1 } from '../../shared/student-photos/catalog-v1';
import type { PhotoAdminSubjectV1 } from '../../shared/student-photos/admin-http-v1';
import { SYNTHETIC_QR_V1 } from '../../shared/student-portal-contracts/fixtures-v1';
import syntheticPortraitWebp from './assets/synthetic-student-portrait.webp';
import '../styles.css';

/** Local visual preview. Optional personal data lives only in a git-ignored file. */
type LocalStudent = {
  name: string;
  birthYear: string | null;
  classId: number | null;
  classLabel: string;
  shift?: 'MATUTINO' | 'VESPERTINO' | 'NOTURNO';
};
const syntheticView = new URLSearchParams(window.location.search).has('synthetic');
/** The preview's school calendar (none at first, as in production before it is marked). */
let previewCalendar: { version: number; days: unknown[] } = { version: 0, days: [] };
export const localStudents = syntheticView
  ? undefined
  : Object.values(
      import.meta.glob<LocalStudent[]>('./local-data.json', { eager: true, import: 'default' }),
    )[0];
const mock = operationsMockV1();
if (localStudents?.length) {
  const template = mock.accounts[0]!;
  mock.accounts.splice(
    0,
    mock.accounts.length,
    ...localStudents.map((student, index) => ({
      ...template,
      accountId: opIdV1(index + 1),
      link: { academicYear: 2026 as const, studentId: 756001 + index },
      name: student.name,
      classId: student.classId,
      classLabel: student.classLabel,
      eligibility: student.classId === null ? ('unlinked' as const) : ('eligible' as const),
      access:
        student.classId === null
          ? {
              state: 'unresolved' as const,
              enabled: null,
              source: null,
              settingsVersion: null,
              accessPermitted: false,
            }
          : {
              state: 'resolved' as const,
              enabled: true,
              source: {
                kind: 'class' as const,
                academicYear: 2026 as const,
                classId: student.classId,
              },
              settingsVersion: 3,
              accessPermitted: true,
            },
    })),
  );
} else {
  for (const [index, account] of mock.accounts.entries()) {
    account.accountId = opIdV1(9901 + index);
    account.name = [
      'Ana Costa',
      'Bruno Martins',
      'Maria Eduarda de Albuquerque Vasconcelos Ferreira da Silva',
    ][index]!;
    account.classLabel = '7º ANO A';
  }
}
const classes = localStudents?.length
  ? [
      ...new Map(
        localStudents
          .filter((student) => student.classId !== null)
          .map((student) => [
            student.classId!,
            { id: student.classId!, label: student.classLabel, shift: student.shift },
          ]),
      ).values(),
    ]
  : [
      { id: 756001, label: '7º ANO A', shift: 'MATUTINO' as const },
      { id: 756002, label: '7º ANO B', shift: 'VESPERTINO' as const },
    ];
const inScope = (scope: ScopeV1) =>
  mock.accounts.filter(
    (account) =>
      scope.kind === 'school' ||
      (scope.kind === 'class' && account.classId === scope.classId) ||
      (scope.kind === 'account' && account.accountId === scope.accountId),
  );
const pageOf = <T,>(items: T[], cursor: string | undefined, limit: number) => {
  const offset = cursor ? Number(cursor.slice(32)) : 0;
  const end = offset + limit;
  return {
    items: items.slice(offset, end),
    nextCursor: end < items.length ? 'c'.repeat(32) + end : null,
  };
};
const requestId = opIdV1(9900);
const observedAt = '2026-09-25T12:00:00Z';
const meta = { contractVersion: 1, requestId };
const nativeFetch = window.fetch.bind(window);

export const previewFetch: PortalFetchV1 = async (path, init) => {
  init.signal?.throwIfAborted();
  if (path.startsWith('/api/student-photos/admin/image')) {
    const response = await nativeFetch(syntheticView ? syntheticPortraitWebp : path, init);
    return response.headers.get('content-type')?.split(';', 1)[0] === 'image/webp'
      ? response
      : new Response(null, { status: 404 });
  }
  if (path === PHOTO_AVATAR_BATCH_PATH_V1) {
    // The joint avatar read, served from the same local or synthetic images as the single read.
    const { subjects } = JSON.parse(String(init.body)) as { subjects: PhotoAdminSubjectV1[] };
    const images = await Promise.all(
      subjects.map(async (subject) => {
        const response = await nativeFetch(
          syntheticView ? syntheticPortraitWebp : photoImageUrlV1(subject, 'avatar'),
          { signal: init.signal },
        );
        return response.headers.get('content-type')?.split(';', 1)[0] === 'image/webp'
          ? new Uint8Array(await response.arrayBuffer())
          : null;
      }),
    );
    return new Response(encodePhotoAvatarBatchV1(images).buffer as ArrayBuffer, {
      headers: { 'Content-Type': PHOTO_AVATAR_BATCH_TYPE_V1 },
    });
  }
  if (path === '/api/me')
    return opJsonV1({
      authenticated: true,
      identityKey: 'preview-sintetico-admin',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      capabilities: ['platform.settings.read', 'platform.settings.write'],
    });
  if (path === '/api/gradebook/operational-workspace') {
    const input = JSON.parse(String(init.body)) as { offset: number; limit: number; query: string };
    const filtered = classes.filter((item) =>
      item.label.toLocaleLowerCase('pt-BR').includes(input.query.toLocaleLowerCase('pt-BR')),
    );
    return opJsonV1({
      contractVersion: 2,
      state: 'ready',
      operation: 'search',
      context: { year: 2026, minimumApprovalMilli: 60000, maxCouncilComponents: 2 },
      items: filtered.slice(input.offset, input.offset + input.limit).map((item) => ({
        entity: { kind: 'class-group' as const, id: item.id, label: item.label },
        description: null,
      })),
      nextOffset: input.offset + input.limit < filtered.length ? input.offset + input.limit : null,
    });
  }
  if (path === '/api/student-portal/admin/command') {
    const command = JSON.parse(String(init.body)) as {
      operation: string;
      accountId?: string;
      accountIds?: string[];
      mode?: 'qr-only' | 'qr-name' | 'qr-name-class';
      expectedVersion?: number;
    };
    if (command.operation === 'qr-batch' && command.accountIds && command.mode) {
      // Production answered a 32-card batch in 0.37 s (measured 26/09/2026); keep that wait.
      await new Promise((resolve) => setTimeout(resolve, 400));
      init.signal?.throwIfAborted();
      const chosen = command.accountIds.map((id) =>
        mock.accounts.find((item) => item.accountId === id),
      );
      if (chosen.every(Boolean))
        return opJsonV1({
          ...meta,
          state: 'qr',
          version: command.expectedVersion,
          cards: chosen.map((item, index) => ({
            accountId: item!.accountId,
            // Each card needs its own credential; the app rejects repeated QR payloads.
            qr: SYNTHETIC_QR_V1.replace('a'.repeat(43), String(index + 1).padStart(43, 'a')),
            mode: command.mode,
            ...(command.mode !== 'qr-only' ? { name: item!.name } : {}),
            ...(command.mode === 'qr-name-class' ? { classLabel: item!.classLabel } : {}),
          })),
        });
    }
    if (command.operation === 'school-calendar-set') {
      // Calendário escolar: saved as is (the contract already refused more than 200 school days).
      const calendar = command as unknown as { expectedVersion: number; days: unknown[] };
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (calendar.expectedVersion !== previewCalendar.version)
        return opJsonV1({ ...meta, state: 'conflict' }, 409);
      previewCalendar = { version: previewCalendar.version + 1, days: calendar.days };
      return opJsonV1({ ...meta, state: 'committed', operationId: opIdV1(9970), version: previewCalendar.version });
    }
    if (command.operation === 'settings-set' || command.operation === 'settings-inherit') {
      const settings = command as unknown as {
        operation: string;
        scope: PolicyScopeV1;
        value?: Partial<EffectiveSettingsV1['value']>;
        keys?: (keyof EffectiveSettingsV1['value'])[];
      };
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (settings.scope.kind === 'school') Object.assign(previewSchool, settings.value ?? {});
      else {
        const key = previewScopeKey(settings.scope);
        const current = { ...(previewOverrides.get(key) ?? {}) };
        if (settings.operation === 'settings-set') Object.assign(current, settings.value);
        else for (const field of settings.keys ?? []) delete current[field];
        previewOverrides.set(key, current);
      }
      previewSettingsVersion += 1;
      return opJsonV1({
        ...meta,
        state: 'committed',
        operationId: opIdV1(9960),
        version: previewSettingsVersion,
      });
    }
    if (command.operation === 'bulk-execute') {
      // Each write answers like a production round trip, so the progress bar is visible.
      await new Promise((resolve) => setTimeout(resolve, 250));
      init.signal?.throwIfAborted();
      return opJsonV1({ ...meta, state: 'committed', operationId: opIdV1(9950), version: 4 });
    }
    const account = mock.accounts.find((item) => item.accountId === command.accountId);
    if (
      command.operation === 'qr-reprint' &&
      account?.firstAccess.qrIssued &&
      command.expectedVersion === account.version
    )
      return opJsonV1({
        ...meta,
        state: 'qr',
        version: account.version,
        cards: [{ accountId: account.accountId, qr: SYNTHETIC_QR_V1, mode: 'qr-only' }],
      });
    return opJsonV1({ ...meta, state: 'forbidden' }, 403);
  }
  if (path !== '/api/student-portal/admin/query')
    return opJsonV1({ ...meta, state: 'not-found' }, 404);

  const query = JSON.parse(String(init.body)) as AdminQueryV1 | AdminReadQueryV2;
  const scope = query.scope;
  if (query.operation === 'settings')
    return opJsonV1({ ...meta, state: 'settings', settings: previewSettingsV1(scope) });
  if (scope.kind === 'shift') return opJsonV1({ ...meta, state: 'not-found' }, 404);
  if (query.operation === 'shifts-read') {
    const shifts = [...new Set(classes.flatMap((item) => (item.shift ? [item.shift] : [])))];
    return opJsonV1({
      ...meta,
      contractVersion: 2,
      state: 'shifts-read',
      observedAt,
      items: shifts.map((shift) => ({
        shift,
        ownFields: Object.keys(previewOverrides.get(`shift:${shift}`) ?? {}),
        classes: classes
          .filter((item) => item.shift === shift)
          .map((item) => ({
            classId: item.id,
            label: item.label,
            ownFields: Object.keys(previewOverrides.get(`class:${item.id}`) ?? {}),
          })),
      })),
    });
  }
  if (query.operation === 'publication')
    return opJsonV1({ ...meta, state: 'publication', items: publicationFixtureV1(scope).items });
  if (query.operation === 'birth-years')
    return opJsonV1({
      ...meta,
      state: 'birth-years',
      scopeVersion: 7,
      ...pageOf(
        inScope(scope).map((account) => ({
          accountId: account.accountId,
          accountVersion: account.version,
          year: localStudents?.[mock.accounts.indexOf(account)]?.birthYear ?? null,
          confirmation: localStudents?.[mock.accounts.indexOf(account)]?.birthYear
            ? 'confirmed'
            : null,
          version: 1,
        })),
        query.page.cursor,
        query.page.limit,
      ),
    });
  if (query.operation === 'settings-overrides')
    return opJsonV1({
      ...meta,
      contractVersion: 2,
      state: 'settings-overrides',
      observedAt,
      scope,
      items: [],
      nextCursor: null,
    });
  if (query.operation === 'customizations-read')
    return opJsonV1({
      ...meta,
      contractVersion: 2,
      state: 'customizations-read',
      observedAt,
      scope,
      publicationVersion: 7,
      items: [],
      nextCursor: null,
      context:
        scope.kind === 'school'
          ? null
          : {
              scope,
              resolved: true,
              publications: publicationFixtureV1(scope).items.map((item) => {
                const inherited = {
                  source: item.publishedRevision ? { kind: 'school', academicYear: 2026 } : null,
                  revision: item.publishedRevision,
                  version: item.publishedRevision ? item.version : null,
                };
                return {
                  period: item.period,
                  school: inherited,
                  inherited,
                  current: inherited,
                  customized: false,
                  ownVersion: null,
                };
              }),
            },
    });
  if (query.operation === 'closing-preview')
    return opJsonV1({
      ...meta,
      contractVersion: 2,
      state: 'closing-preview',
      observedAt,
      scope,
      available: true,
      visibleToStudent: false,
      mode: 'conclusion',
      closedPeriods: ['T1'],
      subjects: [
        {
          subjectId: 800001,
          label: 'MATEMÁTICA',
          closings: [
            {
              period: 'T1',
              mode: 'conclusion',
              level: 'attention',
              conclusion: { code: 'conclusion.attention', variant: 0 },
              weight: { code: 'weight.assessments', variant: 0 },
              strength: { code: 'strength.activities', variant: 0 },
              action: { code: 'action.assessments', variant: 0 },
            },
          ],
        },
        {
          subjectId: 800002,
          label: 'LÍNGUA PORTUGUESA',
          closings: [
            {
              period: 'T1',
              mode: 'conclusion',
              level: 'good',
              conclusion: { code: 'line.good', variant: 0 },
            },
          ],
        },
      ],
      summary: {
        period: 'T1',
        mode: 'conclusion',
        message: { code: 'summary.few-attention', variant: 0 },
        attentionSubjectIds: [800001],
      },
    });
  if (query.operation === 'seals-read') {
    // Synthetic Selos brilhantes (29/09/2026).
    const members = scope.kind === 'account'
      ? mock.accounts.filter((item) => item.accountId === scope.accountId)
      : mock.accounts.filter((item) => scope.kind === 'class'
        ? item.classId === scope.classId : query.accountIds?.includes(item.accountId));
    return opJsonV1({
      ...meta, contractVersion: 2, state: 'seals-read', observedAt,
      items: members.map((item, index) => ({ accountId: item.accountId, seals: (index * 3) % 7 })),
    });
  }
  if (query.operation === 'audit' || query.operation === 'audit-detail') {
    // Synthetic sign-in events with refusal reasons (owner request 29/09/2026).
    const people = mock.accounts.slice(0, 3);
    const event = (index: number, kind: 'login' | 'login-failed' | 'activated', detail: object) => {
      const person = people[index % people.length]!;
      return {
        eventId: `75600000-0000-4000-9000-${String(index + 1).padStart(12, '0')}`,
        at: new Date(Date.parse(observedAt) - index * 90_000).toISOString(),
        actorId: person.accountId,
        accountId: person.accountId,
        scope: { kind: 'account', academicYear: 2026, accountId: person.accountId },
        kind,
        result: kind === 'login-failed' ? 'denied' : 'success',
        requestId,
        version: 1,
        maskedIp: null,
        detail,
        entities: {
          actorName: null,
          subjectName: person.name,
          classId: person.classId,
          classLabel: person.classLabel,
        },
      };
    };
    const device = { platform: 'android', browser: 'chrome' };
    const items = [
      event(0, 'login', { keepConnected: true, device }),
      event(1, 'login-failed', { reason: 'wrong-password', step: 'password', failures: 2, blockAfter: 4, device }),
      event(2, 'login-failed', { reason: 'card-replaced', step: 'card' }),
      event(3, 'activated', { keepConnected: false, device: { platform: 'ios', browser: 'safari' } }),
      event(4, 'login-failed', { reason: 'temporarily-blocked', step: 'pin', failures: 4, blockAfter: 4, blockedUntil: observedAt }),
    ];
    if (query.operation === 'audit-detail')
      return opJsonV1({
        ...meta,
        state: 'audit-detail',
        observedAt,
        event: items.find((item) => item.eventId === query.eventId) ?? items[0],
        ip: null,
        ipExpiresAt: null,
      });
    return opJsonV1({ ...meta, state: 'audit', items, nextCursor: null });
  }
  if (query.operation === 'presence')
    return opJsonV1({
      ...meta,
      state: 'presence',
      connectedStudents: 2,
      observedAt,
      windowSeconds: 60,
    });
  if (query.operation === 'links-preview')
    return opJsonV1({
      ...meta,
      state: 'links-preview',
      count: 0,
      previewToken: 'synthetic-preview-token',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      version: 7,
    });
  if (query.operation === 'bulk-preview' && scope.kind === 'class') {
    const items = inScope(scope).map((account) => ({
      accountId: account.accountId,
      version: account.version,
      classId: scope.classId,
      name: account.name,
      classLabel: account.classLabel,
      ineligibility: null,
    }));
    return opJsonV1({
      ...meta,
      state: 'bulk-preview',
      action: query.action,
      scope,
      scopeVersion: 7,
      totalCount: items.length,
      items: items.slice(0, 100),
      proof: 'synthetic_preview_proof_'.repeat(3),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      nextCursor: null,
    });
  }
  if (query.operation === 'accounts')
    return opJsonV1({
      ...meta,
      state: 'accounts',
      scopeVersion: 7,
      ...pageOf(
        inScope(scope).map(
          ({ accountId, link, name, classLabel, state, eligibility, blocked, version }) => ({
            accountId,
            link,
            name,
            classLabel,
            state,
            eligibility,
            blocked,
            version,
          }),
        ),
        query.page.cursor,
        query.page.limit,
      ),
    });
  if (query.operation === 'school-calendar')
    return opJsonV1({
      ...meta,
      state: 'school-calendar',
      calendar: previewCalendar.version
        ? { academicYear: 2026, version: previewCalendar.version, days: previewCalendar.days }
        : null,
    });
  if (query.operation === 'population') {
    const count = mock.accounts.length;
    const unlinked = mock.accounts.filter((account) => account.eligibility === 'unlinked').length;
    return opJsonV1({
      ...meta,
      state: 'population',
      enabled: true,
      version: 7,
      sourceProfiles: count,
      eligibleSourceProfiles: count - unlinked,
      exitSourceProfiles: unlinked,
      classes: classes.length,
      accounts: count,
      eligibleAccounts: count - unlinked,
      deniedAccounts: unlinked,
      missingProfiles: 0,
      overrideRows: 0,
    });
  }
  if (query.operation === 'overview') {
    const response = await mock.reader.query(query);
    if (response.state === 'overview')
      return opJsonV1({
        ...response,
        observedAt,
        counts: {
          accounts: inScope(scope).length,
          active: inScope(scope).length,
          pendingActivation: 0,
          resetRequired: 0,
          blocked: 0,
          unresolved: inScope(scope).filter((account) => account.access.state === 'unresolved')
            .length,
          unlinked: inScope(scope).filter((account) => account.eligibility === 'unlinked').length,
          accessEnabled: inScope(scope).filter((account) => account.access.enabled).length,
          accessPermitted: inScope(scope).filter((account) => account.access.accessPermitted)
            .length,
          validSessions: inScope(scope).some((account) => account.accountId === opIdV1(1)) ? 1 : 0,
        },
      });
  }
  const response =
    query.contractVersion === 2 ? await mock.reader.query(query) : await mock.client.query(query);
  return opJsonV1(response);
};

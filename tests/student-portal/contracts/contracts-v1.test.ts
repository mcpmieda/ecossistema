import { describe, expect, it } from 'vitest';
import { academicLinkV1, ERROR_HTTP_V1, failureV1, healthV1, pageRequestV1, scopeV1 } from '../../../shared/student-portal-contracts/core-v1';
import { activateRequestV1, challengeRequestV1, challengeResponseV1, isWeakPasswordV1, loginRequestV1, logoutRequestV1, logoutResponseV1, passwordV1, pinV1, qrUrlV1, sessionResponseV1 } from '../../../shared/student-portal-contracts/auth-v1';
import { adminCommandV1, adminQueryV1, adminResponseV1, birthYearV1, printCardV1, trustedAdminContextV1 } from '../../../shared/student-portal-contracts/admin-v1';
import { calendarV1, DEFAULT_RISK_V1, disclosureV1, effectiveSettingsV1, riskPolicyV1, settingsOverrideV1 } from '../../../shared/student-portal-contracts/policy-v1';
import { markV1, selfResponseV1 } from '../../../shared/student-portal-contracts/self-v1';
import { EMPTY_CALENDAR_V1, SYNTHETIC_ID_V1 as id, SYNTHETIC_QR_V1 as qr, SYNTHETIC_SELF_V1 as self } from '../../../shared/student-portal-contracts/fixtures-v1';

const meta = { contractVersion: 1, expectedVersion: 0, idempotencyKey: id };
const scope = { kind: 'account', academicYear: 2026, accountId: id };
const envelope = { contractVersion: 1, requestId: id };
const at = '2026-09-01T12:00:00Z';
const value = { accessEnabled: false, accessSchedule: null, showPartials: false, autoUpdate: false, showFinalResult: false, showTermClosing: false, termClosingConclusive: true, showFrequency: false, showSchedule: false, allowedPeriods: [], risk: DEFAULT_RISK_V1, calendar: EMPTY_CALENDAR_V1 };

describe('Portal V1 identity and envelope', () => {
  it('limits opt-in read context to audit detail and single-account birth years', () => {
    const query = { contractVersion: 1, scope, page: { limit: 1 }, includeReadContext: true };
    expect(adminQueryV1.safeParse({ ...query, operation: 'birth-years' }).success).toBe(true);
    expect(adminQueryV1.safeParse({ ...query, operation: 'audit-detail', eventId: id }).success).toBe(true);
    for (const operation of ['accounts', 'health', 'audit', 'publication']) {
      expect(adminQueryV1.safeParse({ ...query, operation }).success).toBe(false);
    }
    expect(adminQueryV1.safeParse({ ...query, operation: 'birth-years', scope: { kind: 'class', academicYear: 2026, classId: 1 } }).success).toBe(false);
  });
  it('constrains private audit metadata without expanding public requests or accepting claims', () => {
    const context = { actorId: id, tenantId: id, requestId: id, authenticatedAt: at, capability: 'platform.settings.read' };
    expect(trustedAdminContextV1.parse(context)).toEqual(context);
    for (const clientIp of [null, '192.0.2.10', '2001:db8::1', '::1']) {
      expect(trustedAdminContextV1.parse({ ...context, clientIp }).clientIp).toBe(clientIp);
    }
    for (const clientIp of ['', 'example.com', '192.0.2.10/24', '2001:db8::/48', '192.0.2.10, 192.0.2.11', '999.0.0.1', 123]) {
      expect(trustedAdminContextV1.safeParse({ ...context, clientIp }).success).toBe(false);
    }
    for (const invalid of [{ ...context, roles: ['ADMINISTRADOR'] }, { ...context, capability: 'admin' }, { ...context, actorId: 'invented' }, { ...context, authenticatedAt: undefined }]) {
      expect(trustedAdminContextV1.safeParse(invalid).success).toBe(false);
    }
    expect(trustedAdminContextV1.safeParse({ ...context, capability: 'platform.settings.write' }).success).toBe(true);
    expect(adminQueryV1.safeParse({ contractVersion: 1, operation: 'health', scope, page: {}, clientIp: '192.0.2.10' }).success).toBe(false);
    expect(adminCommandV1.safeParse({ ...meta, operation: 'qr-issue', accountId: id, clientIp: '192.0.2.10' }).success).toBe(false);
  });
  it('limits link/scope to 2026 and rejects invented identity fields', () => {
    expect(academicLinkV1.parse({ academicYear: 2026, studentId: 1 }).studentId).toBe(1);
    for (const academicYear of [2025, 2027]) expect(academicLinkV1.safeParse({ academicYear, studentId: 1 }).success).toBe(false);
    expect(academicLinkV1.safeParse({ academicYear: 2026, studentId: 1, name: 'Example' }).success).toBe(false);
    for (const v of [scope, { kind: 'school', academicYear: 2026 }, { kind: 'class', academicYear: 2026, classId: 1 }]) expect(scopeV1.safeParse(v).success).toBe(true);
    expect(scopeV1.safeParse({ ...scope, classId: 1 }).success).toBe(false);
  });
  it('bounds pagination and public errors', () => {
    expect(pageRequestV1.parse({}).limit).toBe(50);
    expect(pageRequestV1.safeParse({ limit: 101 }).success).toBe(false);
    expect(pageRequestV1.safeParse({ cursor: '../a', limit: 1 }).success).toBe(false);
    for (const state of Object.keys(ERROR_HTTP_V1)) expect(failureV1.safeParse({ ...envelope, state }).success).toBe(true);
    expect(failureV1.safeParse({ ...envelope, state: 'unauthenticated', name: 'Example' }).success).toBe(false);
    expect(healthV1.safeParse({ contractVersion: 1, state: 'ok', database: 'internal' }).success).toBe(false);
  });
});

describe('Portal V1 authentication boundary', () => {
  it.each(['123', '12345', ' 1234', '１２３４', 'abcd'])('rejects invalid PIN %s', (pin) => expect(pinV1.safeParse(pin).success).toBe(false));
  it.each(['12345', '1234567', '123 56', 'abcdef'])('rejects invalid password %s', (password) => expect(passwordV1.safeParse(password).success).toBe(false));
  it('accepts leading zero and requires matching confirmation', () => {
    expect(pinV1.parse('0001')).toBe('0001');
    expect(passwordV1.parse('013579')).toBe('013579');
    const request = { contractVersion: 1, challenge: 'a'.repeat(43), password: '013579', confirmation: '013579', keepConnected: true };
    expect(activateRequestV1.safeParse(request).success).toBe(true);
    expect(activateRequestV1.safeParse({ ...request, confirmation: '012346' }).success).toBe(false);
  });
  it('constrains QR origin, route and fragment; schema does not claim HMAC verification', () => {
    expect(qrUrlV1.safeParse(qr).success).toBe(true);
    for (const invalid of [qr.replace('https:', 'http:'), qr.replace('aluno.', 'admin.'), qr.replace('/access#', '/api#'), qr.replace('/access#', '/access?qr=x#'), qr.replace('https://', 'https://user:pass@'), qr + '.extra']) expect(qrUrlV1.safeParse(invalid).success).toBe(false);
  });
  it('constrains every public auth DTO and excludes identifiers from login', () => {
    expect(challengeRequestV1.safeParse({ contractVersion: 1, qr, pin: '2001' }).success).toBe(true);
    const login = { contractVersion: 1, qr, password: '013579', keepConnected: false };
    expect(loginRequestV1.safeParse(login).success).toBe(true);
    expect(loginRequestV1.safeParse({ ...login, accountId: id }).success).toBe(false);
    expect(logoutRequestV1.safeParse({ contractVersion: 1 }).success).toBe(true);
    expect(logoutResponseV1.safeParse({ ...envelope, state: 'logged-out' }).success).toBe(true);
    for (const next of ['pin', 'password', 'risk']) expect(challengeResponseV1.safeParse({ ...envelope, state: 'credential-required', next }).success).toBe(true);
    expect(challengeResponseV1.safeParse({ ...envelope, state: 'password-creation', challenge: 'a'.repeat(43), expiresAt: at }).success).toBe(true);
    const session = { ...envelope, state: 'authenticated', expiresAt: at, persistent: true };
    expect(sessionResponseV1.safeParse(session).success).toBe(true);
    expect(sessionResponseV1.safeParse({ ...session, token: 'a'.repeat(43) }).success).toBe(false);
  });
});

describe('Portal V1 weak passwords (owner decision 28/09/2026)', () => {
  it.each([
    '000000', '111111', '999999',
    '012345', '123456', '456789', '987654', '654321', '543210',
    '121212', '101010', '909090', '123123', '707707', '112233', '998877', '001122',
  ])('refuses %s when a password is created', (password) => {
    expect(isWeakPasswordV1(password)).toBe(true);
    expect(activateRequestV1.safeParse({ contractVersion: 1, challenge: 'a'.repeat(43), password, confirmation: password, keepConnected: false }).success).toBe(false);
  });
  it.each(['482913', '013579', '001234', '200100', '246810', '135791', '147258', '123457', '112234'])('accepts %s', (password) => {
    expect(isWeakPasswordV1(password)).toBe(false);
    expect(activateRequestV1.safeParse({ contractVersion: 1, challenge: 'a'.repeat(43), password, confirmation: password, keepConnected: false }).success).toBe(true);
  });
  it('never checks signing in, so passwords created before keep working', () => {
    expect(loginRequestV1.safeParse({ contractVersion: 1, qr, password: '123456', keepConnected: false }).success).toBe(true);
  });
});

describe('Portal V1 calendar, inheritance and birth', () => {
  it('freezes approved defaults and bounded technical fields', () => {
    expect(riskPolicyV1.parse(DEFAULT_RISK_V1)).toMatchObject({ persistentSeconds: 2592000, shortSeconds: 43200, challengeAfter: 3, blockAfter: 5, blockSeconds: 900 });
    for (const override of [{ blockAfter: 3 }, { blockSeconds: -1 }, { shortSeconds: Infinity }, { challengeTtlSeconds: 601 }]) expect(riskPolicyV1.safeParse({ ...DEFAULT_RISK_V1, ...override }).success).toBe(false);
  });
  it('allows unfilled dates but rejects reversed chronology and ambiguous disclosure modes', () => {
    expect(calendarV1.safeParse(EMPTY_CALENDAR_V1).success).toBe(true);
    expect(calendarV1.safeParse({ ...EMPTY_CALENDAR_V1, yearStartsAt: '2026-02-01T00:00:00-03:00', t1EndsAt: '2026-01-01T00:00:00-03:00' }).success).toBe(false);
    expect(calendarV1.safeParse({ ...EMPTY_CALENDAR_V1, t1EndsAt: '2026-05-16T00:00:00-03:00', t2StartsAt: '2026-05-18T00:00:00-03:00' }).success).toBe(true);
    expect(calendarV1.safeParse({ ...EMPTY_CALENDAR_V1, t1EndsAt: '2026-05-18T00:00:00-03:00', t2StartsAt: '2026-05-16T00:00:00-03:00' }).success).toBe(false);
    expect(disclosureV1.safeParse({ mode: 'single', at: null, periods: ['T1', 'T1'] }).success).toBe(false);
    expect(disclosureV1.safeParse({ mode: 'per-period', at: { T1: null, T2: null, T3: null, REC1: null, REC2: null, REC3: null } }).success).toBe(true);
    expect(disclosureV1.safeParse({ mode: 'single', at: null, periods: ['T1'], perPeriod: {} }).success).toBe(false);
  });
  it('requires explicit inheritance sources and disallows empty override', () => {
    expect(settingsOverrideV1.safeParse({}).success).toBe(false);
    expect(settingsOverrideV1.safeParse({ accessEnabled: false }).success).toBe(true);
    const sources = Object.fromEntries(Object.keys(value).map((key) => [key, scope]));
    expect(effectiveSettingsV1.safeParse({ scope, version: 1, value, sources }).success).toBe(true);
    expect(effectiveSettingsV1.safeParse({ scope, version: 1, value, sources: {} }).success).toBe(false);
  });
  it.each(['', '20', '1899', '2027', '200a', ' 2001'])('rejects incomplete/implausible birth %s', (year) => expect(birthYearV1.safeParse(year).success).toBe(false));
  it('distinguishes explicit clear, confirmed and test data; rejects duplicate batch', () => {
    const item = { action: 'set', accountId: id, expectedVersion: 0, year: '2001', confirmation: 'unconfirmed-test' };
    expect(adminCommandV1.safeParse({ ...meta, operation: 'birth-write', item }).success).toBe(true);
    expect(adminCommandV1.safeParse({ ...meta, operation: 'birth-write', item: { action: 'clear', accountId: id, expectedVersion: 0 } }).success).toBe(true);
    expect(adminCommandV1.safeParse({ ...meta, operation: 'birth-write', item: { ...item, year: '' } }).success).toBe(false);
    expect(adminCommandV1.safeParse({ ...meta, operation: 'birth-batch', classId: 1, expectedCount: 2, items: [item, item], confirmed: true }).success).toBe(false);
  });
});

describe('Portal V1 admin and self privacy', () => {
  it('parses all mutation operations and rejects authority claims in request', () => {
    const commands = [
      ...['qr-issue', 'qr-reprint'].map((operation) => ({ ...meta, operation, accountId: id })),
      ...['qr-regenerate', 'password-reset', 'account-reset'].map((operation) => ({ ...meta, operation, accountId: id, confirmed: true })),
      { ...meta, operation: 'block', accountId: id, blocked: true, confirmed: true },
      { ...meta, operation: 'sessions-revoke', scope, confirmed: true },
      { ...meta, operation: 'settings-set', scope, value: { accessEnabled: false }, acknowledgeImmediateEffect: true },
      { ...meta, operation: 'settings-inherit', scope, keys: ['accessEnabled'] },
      ...['publish', 'publish-update'].map((operation) => ({ ...meta, operation, scope, period: 'T1', targetDataVersion: 'revision:1' })),
      { ...meta, operation: 'unpublish', scope, period: 'T1', confirmed: true },
      { ...meta, operation: 'links-close', academicYear: 2026, previewToken: 'a'.repeat(43), expectedCount: 1, confirmed: true },
      { ...meta, operation: 'qr-batch', classId: 1, accountIds: [id], confirmed: true },
      { ...meta, operation: 'birth-batch', classId: 1, expectedCount: 1, items: [{ action: 'clear', accountId: id, expectedVersion: 0 }], confirmed: true },
    ];
    for (const command of commands) {
      expect(adminCommandV1.safeParse(command).success, command.operation).toBe(true);
      expect(adminCommandV1.safeParse({ ...command, role: 'ADMINISTRADOR' }).success).toBe(false);
      expect(adminCommandV1.safeParse({ ...command, expectedVersion: -1 }).success).toBe(false);
    }
  });
  it('bounds queries and requires safe responses', () => {
    for (const operation of ['accounts', 'sessions', 'birth-years', 'settings', 'publication', 'audit', 'health', 'links-preview']) expect(adminQueryV1.safeParse({ contractVersion: 1, operation, scope, page: {} }).success).toBe(true);
    expect(adminResponseV1.safeParse({ ...envelope, state: 'committed', operationId: id, version: 1 }).success).toBe(true);
    expect(adminResponseV1.safeParse({ ...envelope, state: 'accounts', scopeVersion: 0, items: [], nextCursor: null }).success).toBe(true);
    expect(adminResponseV1.safeParse({ ...envelope, state: 'committed', operationId: id, version: 1, password: '482913' }).success).toBe(false);
  });
  it('covers each administrative response without leaking credential internals', () => {
    const sources = Object.fromEntries(Object.keys(value).map((key) => [key, scope]));
    const event = { eventId: id, at, actorId: id, accountId: id, scope, kind: 'birth-changed', result: 'success', requestId: id, version: 1, maskedIp: null };
    const responses = [
      ...['accounts', 'birth-years'].map((state) => ({ ...envelope, state, scopeVersion: 0, items: [], nextCursor: null })),
      { ...envelope, state: 'sessions', version: 0, items: [], nextCursor: null },
      { ...envelope, state: 'audit', items: [], nextCursor: null },
      { ...envelope, state: 'settings', settings: { scope, version: 1, value, sources } },
      { ...envelope, state: 'publication', items: [{ period: 'T1', state: 'published', availableRevision: 'a:1', publishedRevision: 'a:1', version: 1 }] },
      { ...envelope, state: 'health', status: 'normal' },
      { ...envelope, state: 'links-preview', count: 0, previewToken: 'a'.repeat(43), expiresAt: at, version: 1 },
      { ...envelope, state: 'qr', cards: [{ mode: 'qr-only', accountId: id, qr }], version: 1 },
      { ...envelope, state: 'batch', operationId: id, items: [{ accountId: id, state: 'conflict', version: 1 }] },
      { ...envelope, state: 'audit-detail', event, ip: null, ipExpiresAt: null },
    ];
    for (const response of responses) {
      expect(adminResponseV1.safeParse(response).success, response.state).toBe(true);
      expect(adminResponseV1.safeParse({ ...response, verifier: 'private' }).success).toBe(false);
    }
    expect(adminQueryV1.safeParse({ contractVersion: 1, operation: 'audit-detail', scope, page: {} }).success).toBe(false);
    expect(adminQueryV1.safeParse({ contractVersion: 1, operation: 'audit-detail', scope, page: {}, eventId: id }).success).toBe(true);
  });
  it('requires distinct scope, account and birth versions without weakening the administrative allowlist', () => {
    const item = { accountId: id, accountVersion: 11, year: null, confirmation: null, version: 3 };
    const response = { ...envelope, state: 'birth-years', scopeVersion: 27, items: [item], nextCursor: null };
    expect(adminResponseV1.parse(response)).toEqual(response);
    expect(adminResponseV1.safeParse({ ...response, scopeVersion: undefined }).success).toBe(false);
    expect(adminResponseV1.safeParse({ ...response, items: [{ ...item, accountVersion: undefined }] }).success).toBe(false);
    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(adminResponseV1.safeParse({ ...response, scopeVersion: invalid }).success).toBe(false);
      expect(adminResponseV1.safeParse({ ...response, items: [{ ...item, accountVersion: invalid }] }).success).toBe(false);
    }
    for (const privateKey of ['password', 'pin', 'verifier', 'tokenHash'])
      expect(adminResponseV1.safeParse({ ...response, items: [{ ...item, [privateKey]: 'private' }] }).success).toBe(false);
    for (const [state, key] of [['accounts', 'scopeVersion'], ['sessions', 'version']] as const) {
      const base = { ...envelope, state, items: [], nextCursor: null };
      expect(adminResponseV1.safeParse(base).success).toBe(false);
      expect(adminResponseV1.safeParse({ ...base, [key]: 0 }).success).toBe(true);
      expect(adminResponseV1.safeParse({ ...base, [key]: Number.MAX_SAFE_INTEGER }).success).toBe(true);
      expect(adminResponseV1.safeParse({ ...base, [key]: -1 }).success).toBe(false);
    }
  });
  it('enforces the three print modes without adding secrets or names to QR-only', () => {
    for (const card of [{ mode: 'qr-only', accountId: id, qr }, { mode: 'qr-name', accountId: id, qr, name: 'Example' }, { mode: 'qr-name-class', accountId: id, qr, name: 'Example', classLabel: 'Example class' }]) {
      expect(printCardV1.safeParse(card).success).toBe(true);
      expect(printCardV1.safeParse({ ...card, birthYear: '2001' }).success).toBe(false);
    }
    expect(printCardV1.safeParse({ mode: 'qr-only', accountId: id, qr, name: 'Example' }).success).toBe(false);
  });
  it('preserves zero/NC/absent/RR and omits unapproved data', () => {
    expect(selfResponseV1.safeParse(self).success).toBe(true);
    for (const kind of ['nc', 'absent', 'rr', 'recovery-pending']) expect(markV1.safeParse({ kind }).success).toBe(true);
    expect(selfResponseV1.safeParse({ ...self, state: 'no-publication' }).success).toBe(false);
    expect(selfResponseV1.safeParse({ ...self, profile: { ...self.profile, academicState: 'assisted' } }).success).toBe(false);
    expect(selfResponseV1.safeParse({ ...self, profile: { ...self.profile, academicState: 'assisted', result: 'not-applicable' } }).success).toBe(true);
    expect(selfResponseV1.safeParse({ ...self, rawSourceEvidence: {} }).success).toBe(false);
    expect(self.subjects[0]?.periods[0]).not.toHaveProperty('partials');
  });
});

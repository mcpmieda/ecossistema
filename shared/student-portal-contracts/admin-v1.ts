import { z } from 'zod';
import { STUDENT_NAME_MAX_LENGTH_V1 } from '../student-identity/student-identity-v1';
import { accountStateV1, academicLinkV1, commandMetaV1, eligibilityStateV1, instantV1, opaqueV1, pageCursorV1, pageRequestV1, periodV1, portalIdV1, publicationStateV1, revisionV1, scopeV1, versionV1, policyScopeV1 } from './core-v1';
import { qrUrlV1 } from './auth-v1';
import { effectiveSettingsV1, policyFieldV1, POLICY_FIELDS_V1, settingsOverrideV1 } from './policy-v1';
import { schoolCalendarDaysV1, schoolCalendarV1 } from './school-calendar-v1';
import { schoolBellsDaysV1, schoolBellsV1 } from './school-bells-v1';
import { publicationInheritCommandV1 } from './customizations-v1';
import { bulkActionV1, bulkCursorV1, bulkExecuteCommandV1, bulkPreviewQueryV1, bulkPreviewResponseV1 } from './bulk-v1';

// Private binding metadata only. Valid shape does not authenticate the caller.
export const trustedAdminContextV1 = z.object({
  actorId: portalIdV1, actorName: z.string().min(1).max(200).optional(), tenantId: portalIdV1, requestId: portalIdV1,
  authenticatedAt: instantV1, capability: z.enum(['platform.settings.read', 'platform.settings.write']),
  clientIp: z.union([z.ipv4(), z.ipv6()]).nullable().optional(),
}).strict();

export const birthYearV1 = z.string().regex(/^\d{4}$/u).refine((s) => Number(s) >= 1900 && Number(s) <= 2026, 'Birth year outside V1 range');
export const birthWriteV1 = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set'), accountId: portalIdV1, expectedVersion: versionV1, year: birthYearV1, confirmation: z.enum(['confirmed', 'unconfirmed-test']) }).strict(),
  z.object({ action: z.literal('clear'), accountId: portalIdV1, expectedVersion: versionV1 }).strict(),
]);
const account = { ...commandMetaV1, accountId: portalIdV1 };
export const printModeV1 = z.enum(['qr-only', 'qr-name', 'qr-name-class']);
export const adminCommandV1 = z.discriminatedUnion('operation', [
  bulkExecuteCommandV1,
  publicationInheritCommandV1,
  z.object({ ...account, operation: z.literal('qr-issue') }).strict(),
  z.object({ ...account, operation: z.literal('qr-reprint') }).strict(),
  z.object({ ...account, operation: z.literal('qr-regenerate'), confirmed: z.literal(true) }).strict(),
  z.object({ ...account, operation: z.literal('password-reset'), confirmed: z.literal(true) }).strict(),
  z.object({ ...account, operation: z.literal('account-reset'), confirmed: z.literal(true) }).strict(),
  z.object({ ...account, operation: z.literal('block'), blocked: z.boolean(), confirmed: z.literal(true) }).strict(),
  z.object({ ...commandMetaV1, operation: z.literal('sessions-revoke'), scope: scopeV1, sessionId: portalIdV1.optional(), confirmed: z.literal(true) }).strict(),
  z.object({ ...commandMetaV1, operation: z.literal('birth-write'), item: birthWriteV1, includeSavedBirth: z.literal(true).optional() }).strict(),
  z.object({ ...commandMetaV1, operation: z.literal('birth-batch'), classId: z.number().int().positive(), expectedCount: z.number().int().min(1).max(100), items: z.array(birthWriteV1).min(1).max(100), confirmed: z.literal(true) }).strict(),
  z.object({ ...commandMetaV1, operation: z.literal('settings-set'), scope: policyScopeV1, value: settingsOverrideV1, acknowledgeImmediateEffect: z.boolean() }).strict(),
  z.object({ ...commandMetaV1, operation: z.literal('settings-inherit'), scope: policyScopeV1, keys: z.array(policyFieldV1).min(1).max(POLICY_FIELDS_V1.length) }).strict(),
  z.object({ ...commandMetaV1, operation: z.literal('publish'), scope: scopeV1, period: periodV1, targetDataVersion: revisionV1 }).strict(),
  z.object({ ...commandMetaV1, operation: z.literal('publish-update'), scope: scopeV1, period: periodV1, targetDataVersion: revisionV1 }).strict(),
  z.object({ ...commandMetaV1, operation: z.literal('unpublish'), scope: scopeV1, period: periodV1, confirmed: z.literal(true) }).strict(),
  z.object({ ...commandMetaV1, operation: z.literal('links-close'), academicYear: z.literal(2026), previewToken: opaqueV1, expectedCount: z.number().int().nonnegative(), confirmed: z.literal(true) }).strict(),
  z.object({ ...commandMetaV1, operation: z.literal('population-start'), academicYear: z.literal(2026), clearOverrides: z.literal(true), confirmed: z.literal(true) }).strict(),
  // Calendário escolar (owner decision 22/10/2026): the whole year's marked days, school-wide.
  z.object({ ...commandMetaV1, operation: z.literal('school-calendar-set'), academicYear: z.literal(2026), days: schoolCalendarDaysV1 }).strict(),
  // Horário das aulas (owner decision 23/10/2026): each lesson's and the break's time, school-wide.
  z.object({ ...commandMetaV1, operation: z.literal('school-bells-set'), academicYear: z.literal(2026), bells: schoolBellsDaysV1 }).strict(),
  z.object({ ...commandMetaV1, operation: z.literal('qr-batch'), classId: z.number().int().positive(), accountIds: z.array(portalIdV1).min(1).max(100), mode: printModeV1.default('qr-name-class'), confirmed: z.literal(true) }).strict(),
]).superRefine((v, ctx) => {
  if (v.operation === 'birth-batch' && (v.expectedCount !== v.items.length || new Set(v.items.map((i) => i.accountId)).size !== v.items.length)) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Scope count or duplicate account' });
  if (v.operation === 'sessions-revoke' && v.sessionId && v.scope.kind !== 'account') ctx.addIssue({ code: 'custom', path: ['scope'], message: 'Individual session requires account scope' });
  if (v.operation === 'qr-batch' && new Set(v.accountIds).size !== v.accountIds.length) ctx.addIssue({ code: 'custom', path: ['accountIds'], message: 'Duplicate account' });
});
export const auditKindV1 = z.enum(['login', 'login-failed', 'activated', 'password-reset', 'account-reset', 'qr-issued', 'qr-reprinted', 'qr-regenerated', 'blocked', 'unblocked', 'session-revoked', 'birth-changed', 'settings-changed', 'published', 'unpublished', 'projection-updated', 'links-closed']);
export const adminQueryV1 = z.object({
  contractVersion: z.literal(1), operation: z.enum(['accounts', 'sessions', 'birth-years', 'settings', 'publication', 'audit', 'audit-detail', 'presence', 'health', 'links-preview', 'population', 'bulk-preview', 'school-calendar', 'school-bells']),
  scope: policyScopeV1, page: pageRequestV1.extend({ cursor: bulkCursorV1.optional() }), action: bulkActionV1.optional(), from: instantV1.optional(), until: instantV1.optional(), event: auditKindV1.optional(), result: z.enum(['success', 'denied', 'failed']).optional(),
  includeReadContext: z.literal(true).optional(), includeEntities: z.literal(true).optional(), eventId: portalIdV1.optional(), accountState: accountStateV1.optional(), blocked: z.boolean().optional(), nameSearch: z.string().min(1).max(200).optional(),
}).strict().refine((v) => !v.from || !v.until || Date.parse(v.from) <= Date.parse(v.until), 'Invalid interval')
  // A shift is a policy level only: its settings can be read, nothing else is scoped by shift.
  .refine((v) => v.scope.kind !== 'shift' || v.operation === 'settings', 'Shift scope is only for settings')
  .refine((v) => v.operation !== 'audit-detail' || v.eventId !== undefined, 'Audit detail requires eventId')
  .refine((v) => !v.includeReadContext || v.operation === 'audit-detail' ||
    (v.operation === 'birth-years' && v.scope.kind === 'account'), 'Read context requires audit detail or account birth years')
  .refine((v) => !v.includeEntities || v.operation === 'audit' || v.operation === 'audit-detail', 'Entities require audit')
  .refine((v) => v.operation === 'bulk-preview' ? bulkPreviewQueryV1.safeParse(v).success : v.action === undefined && pageRequestV1.safeParse(v.page).success, 'Invalid bulk preview');
export const accountSummaryV1 = z.object({ accountId: portalIdV1, link: academicLinkV1.nullable(), name: z.string().max(STUDENT_NAME_MAX_LENGTH_V1), classLabel: z.string().max(80), state: accountStateV1, eligibility: eligibilityStateV1, blocked: z.boolean(), version: versionV1 }).strict();
const card = { accountId: portalIdV1, qr: qrUrlV1 };
export const printCardV1 = z.discriminatedUnion('mode', [
  z.object({ ...card, mode: z.literal('qr-only') }).strict(),
  z.object({ ...card, mode: z.literal('qr-name'), name: z.string().min(1).max(STUDENT_NAME_MAX_LENGTH_V1) }).strict(),
  z.object({ ...card, mode: z.literal('qr-name-class'), name: z.string().min(1).max(STUDENT_NAME_MAX_LENGTH_V1), classLabel: z.string().min(1).max(80) }).strict(),
]);
/**
 * Why a sign-in was refused and what helps support the family (owner request 29/09/2026). Only
 * operational facts about the attempt itself: never a secret, a mark or another student.
 */
export const AUDIT_REASONS_V1 = [
  'wrong-pin', 'wrong-password', 'temporarily-blocked', 'verification-required', 'access-closed',
  'card-replaced', 'account-blocked', 'not-enrolled', 'first-access-pending', 'first-access-not-ready',
  'password-window-expired', 'already-active', 'retry-needed',
] as const;
export const auditDetailV1 = z.object({
  reason: z.enum(AUDIT_REASONS_V1).optional(),
  step: z.enum(['card', 'pin', 'password', 'create']).optional(),
  failures: z.number().int().min(0).max(1000).optional(),
  blockAfter: z.number().int().min(1).max(1000).optional(),
  blockedUntil: instantV1.optional(),
  keepConnected: z.boolean().optional(),
  device: z.object({
    platform: z.enum(['android', 'ios', 'windows', 'macos', 'linux', 'chromeos', 'other']),
    browser: z.enum(['chrome', 'safari', 'firefox', 'edge', 'samsung', 'other']),
  }).strict().optional(),
}).strict();
export type AuditDetailV1 = z.infer<typeof auditDetailV1>;
export const auditEventV1 = z.object({ eventId: portalIdV1, at: instantV1, actorId: portalIdV1, accountId: portalIdV1.nullable(), scope: policyScopeV1, kind: auditKindV1, result: z.enum(['success', 'denied', 'failed']), requestId: portalIdV1, version: versionV1, maskedIp: z.string().max(64).nullable(), detail: auditDetailV1.optional(), entities: z.object({ actorName: z.string().max(200).nullable(), subjectName: z.string().max(STUDENT_NAME_MAX_LENGTH_V1).nullable(), classId: z.number().int().positive().nullable(), classLabel: z.string().max(80).nullable() }).strict().optional() }).strict();
/** Opt-in acknowledgement read inside the write transaction; no credential material.
 * A replay after a later account change omits this snapshot and retains the original receipt.
 */
export const savedBirthV1 = z.object({
  accountId: portalIdV1, classId: z.number().int().positive().safe(),
  accountVersion: versionV1, version: versionV1,
  year: birthYearV1.nullable(), confirmation: z.enum(['confirmed', 'unconfirmed-test']).nullable(),
}).strict();
export type SavedBirthV1 = z.infer<typeof savedBirthV1>;
const base = { contractVersion: z.literal(1), requestId: portalIdV1 };
const paging = { nextCursor: pageCursorV1.nullable() };
export const adminResponseV1 = z.discriminatedUnion('state', [
  bulkPreviewResponseV1,
  z.object({ ...base, state: z.literal('accounts'), scopeVersion: versionV1, items: z.array(accountSummaryV1).max(100), ...paging }).strict(),
  z.object({ ...base, state: z.literal('sessions'), version: versionV1, items: z.array(z.object({ sessionId: portalIdV1, accountId: portalIdV1, expiresAt: instantV1, revokedAt: instantV1.nullable() }).strict()).max(100), ...paging }).strict(),
  z.object({ ...base, state: z.literal('birth-years'), scopeVersion: versionV1, accountsScopeVersion: versionV1.optional(), items: z.array(z.object({ accountId: portalIdV1, accountVersion: versionV1, year: birthYearV1.nullable(), confirmation: z.enum(['confirmed', 'unconfirmed-test']).nullable(), version: versionV1 }).strict()).max(100), ...paging }).strict(),
  z.object({ ...base, state: z.literal('settings'), settings: effectiveSettingsV1 }).strict(),
  z.object({ ...base, state: z.literal('publication'), items: z.array(z.object({ period: periodV1, state: publicationStateV1, availableRevision: revisionV1.nullable(), publishedRevision: revisionV1.nullable(), version: versionV1 }).strict()).max(6) }).strict(),
  z.object({ ...base, state: z.literal('audit'), items: z.array(auditEventV1).max(100), ...paging }).strict(),
  z.object({ ...base, state: z.literal('audit-detail'), observedAt: instantV1.optional(), event: auditEventV1, ip: z.union([z.ipv4(), z.ipv6()]).nullable(), ipExpiresAt: instantV1.nullable() }).strict(),
  z.object({ ...base, state: z.literal('presence'), connectedStudents: z.number().int().nonnegative().safe(), observedAt: instantV1, windowSeconds: z.literal(60) }).strict(),
  z.object({ ...base, state: z.literal('health'), status: z.enum(['normal', 'attention', 'intervention']) }).strict(),
  z.object({ ...base, state: z.literal('links-preview'), count: z.number().int().nonnegative(), previewToken: opaqueV1, expiresAt: instantV1, version: versionV1 }).strict(),
  z.object({ ...base, state: z.literal('population'), enabled: z.boolean(), version: versionV1, sourceProfiles: z.number().int().nonnegative().safe(), eligibleSourceProfiles: z.number().int().nonnegative().safe(), exitSourceProfiles: z.number().int().nonnegative().safe(), classes: z.number().int().nonnegative().safe(), accounts: z.number().int().nonnegative().safe(), eligibleAccounts: z.number().int().nonnegative().safe(), deniedAccounts: z.number().int().nonnegative().safe(), missingProfiles: z.number().int().nonnegative().safe(), overrideRows: z.number().int().nonnegative().safe() }).strict(),
  z.object({ ...base, state: z.literal('school-calendar'), calendar: schoolCalendarV1.nullable() }).strict(),
  z.object({ ...base, state: z.literal('school-bells'), bells: schoolBellsV1.nullable() }).strict(),
  z.object({ ...base, state: z.literal('committed'), operationId: portalIdV1, version: versionV1, savedBirth: savedBirthV1.optional() }).strict(),
  z.object({ ...base, state: z.literal('qr'), cards: z.array(printCardV1).min(1).max(100), version: versionV1 }).strict(),
  z.object({ ...base, state: z.literal('batch'), operationId: portalIdV1, items: z.array(z.object({ accountId: portalIdV1, state: z.enum(['committed', 'conflict', 'forbidden', 'unavailable']), version: versionV1 }).strict()).max(100) }).strict(),
]);
export const ADMIN_BODY_BYTES_V1 = 65536;
export type AdminCommandV1 = z.infer<typeof adminCommandV1>;
export type AdminQueryV1 = z.infer<typeof adminQueryV1>;
export type AdminResponseV1 = z.infer<typeof adminResponseV1>;

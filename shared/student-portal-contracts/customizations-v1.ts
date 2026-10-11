import { z } from 'zod';
import { STUDENT_NAME_MAX_LENGTH_V1 } from '../student-identity/student-identity-v1';
import { settingsOverrideV1 } from './policy-v1';
import { accountStateV1, commandMetaV1, instantV1, opaqueV1, periodV1, policyScopeV1, portalIdV1, revisionV1, scopeV1, versionV1 } from './core-v1';

/** Current differences only. A publication decision is not a grant of student access. */
export const publicationChoiceV1 = z.object({
  source: scopeV1.nullable(), revision: revisionV1.nullable(), version: versionV1.nullable(),
}).strict();
export const publicationContextItemV1 = z.object({
  period: periodV1, current: publicationChoiceV1, inherited: publicationChoiceV1, school: publicationChoiceV1,
  customized: z.boolean(), ownVersion: versionV1.nullable(),
}).strict();
export const customizationRowV1 = z.object({
  id: z.string().regex(/^(?:class:2026:[1-9]\d*|shift:2026:(?:MATUTINO|VESPERTINO|NOTURNO)|account:2026:[0-9a-f-]{36})$/u),
  scope: policyScopeV1.refine((scope) => scope.kind !== 'school'),
  label: z.string().max(STUDENT_NAME_MAX_LENGTH_V1), classLabel: z.string().max(80),
  classId: z.number().int().positive().safe().nullable(),
  accountState: accountStateV1.nullable(), accountVersion: versionV1.nullable(),
  settingsVersion: versionV1, publicationVersion: versionV1,
  value: settingsOverrideV1.nullable(), inheritedValue: settingsOverrideV1.nullable(), schoolValue: settingsOverrideV1.nullable(),
  blocked: z.boolean(), publications: z.array(publicationContextItemV1).max(6), updatedAt: instantV1,
}).strict().superRefine((row, ctx) => {
  const id = row.scope.kind === 'class' ? `class:2026:${row.scope.classId}`
    : row.scope.kind === 'shift' ? `shift:2026:${row.scope.shift}`
      : row.scope.kind === 'account' ? `account:2026:${row.scope.accountId.toLowerCase()}` : '';
  if (row.id !== id || (row.scope.kind === 'class' && (row.classId !== row.scope.classId || row.blocked)))
    ctx.addIssue({ code: 'custom', message: 'Invalid customization owner' });
  // A shift owns options only (owner decision 28/09/2026): no class, block or publication.
  if (row.scope.kind === 'shift' && (row.classId !== null || row.blocked || row.publications.length > 0))
    ctx.addIssue({ code: 'custom', message: 'Invalid shift customization' });
  if (row.value === null && !row.blocked && row.publications.length === 0)
    ctx.addIssue({ code: 'custom', message: 'Empty customization row' });
  if (new Set(row.publications.map((item) => item.period)).size !== row.publications.length ||
      row.publications.some((item) => !item.customized || item.ownVersion === null))
    ctx.addIssue({ code: 'custom', message: 'Only current own differences belong in the inventory' });
  const fields = Object.keys(row.value ?? {}).sort((left, right) => left.localeCompare(right)).join(',');
  if (fields !== Object.keys(row.inheritedValue ?? {}).sort((left, right) => left.localeCompare(right)).join(',') || fields !== Object.keys(row.schoolValue ?? {}).sort((left, right) => left.localeCompare(right)).join(','))
    ctx.addIssue({ code: 'custom', message: 'Missing option comparison' });
});
export const customizationsResponseV1 = z.object({
  contractVersion: z.literal(2), state: z.literal('customizations-read'), requestId: portalIdV1,
  observedAt: instantV1, scope: scopeV1, publicationVersion: versionV1,
  items: z.array(customizationRowV1).max(100), nextCursor: opaqueV1.nullable(),
  context: z.object({
    scope: scopeV1.refine((scope) => scope.kind !== 'school'), resolved: z.boolean(),
    publications: z.array(publicationContextItemV1).max(6),
  }).strict().nullable(),
}).strict().superRefine((page, ctx) => {
  if (new Set(page.items.map((item) => item.id)).size !== page.items.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate customization owner' });
  for (const row of page.items) {
    if ((page.scope.kind === 'class' && row.classId !== page.scope.classId) ||
        (page.scope.kind === 'account' && (row.scope.kind !== 'account' || row.scope.accountId.toLowerCase() !== page.scope.accountId.toLowerCase())))
      ctx.addIssue({ code: 'custom', message: 'Customization scope mismatch' });
  }
  if (page.context && JSON.stringify(page.context.scope) !== JSON.stringify(page.scope))
    ctx.addIssue({ code: 'custom', message: 'Context scope mismatch' });
});
/** Deactivates exactly one own release decision; never unpublishes or copies a parent. */
export const publicationInheritCommandV1 = z.object({
  ...commandMetaV1, operation: z.literal('publication-inherit'),
  scope: scopeV1.refine((scope) => scope.kind !== 'school'), period: periodV1,
  expectedDecisionVersion: versionV1, confirmed: z.literal(true),
}).strict();
export type CustomizationRowV1 = z.infer<typeof customizationRowV1>;
export type PublicationContextItemV1 = z.infer<typeof publicationContextItemV1>;
export type CustomizationsResponseV1 = z.infer<typeof customizationsResponseV1>;

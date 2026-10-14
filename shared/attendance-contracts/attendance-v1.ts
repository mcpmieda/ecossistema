import { z } from 'zod';
import { studentUidV1 } from '../student-identity/student-identity-v1';

export const ATTENDANCE_CONTRACT_V1 = 'attendance-v1';
export const ATTENDANCE_BODY_BYTES_V1 = 1_048_576;
const key = z.string().trim().min(1).max(200);
const originalText = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const attendanceScopeV1 = z
  .object({
    academicYear: z.number().int().min(1900).max(9999),
    classId: z.number().int().positive().max(2_147_483_647),
  })
  .strict();
export const attendanceDateV1 = z.iso.date();
const slot = z.number().int().min(1).max(6);
const slots = z
  .array(slot)
  .min(1)
  .max(6)
  .refine((v) => new Set(v).size === v.length);
export const sourceRecordV1 = z
  .object({
    recordKey: key,
    originalName: originalText,
    originalClass: originalText,
    identityBasis: z.enum(['durable', 'report-local']),
  })
  .strict();
const day = z
  .object({
    date: attendanceDateV1,
    eligible: z.boolean(),
    slots,
  })
  .strict();
const coverage = z
  .object({
    recordKey: key,
    date: attendanceDateV1,
    slots,
    complete: z.boolean(),
  })
  .strict();
const mark = z
  .object({
    recordKey: key,
    date: attendanceDateV1,
    slot,
    mark: z.enum(['X', 'J']),
  })
  .strict();
const common = { scope: attendanceScopeV1, requestId: studentUidV1 };
const write = { ...common, expectedRevision: version };
export const attendanceRequestV1 = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('review'), scope: attendanceScopeV1 }).strict(),
  z
    .object({
      operation: z.literal('configure'),
      ...write,
      calendar: z.array(day).min(1).max(366),
      enrollments: z
        .array(
          z
            .object({
              studentUid: studentUidV1,
              startsOn: attendanceDateV1,
              endsOn: attendanceDateV1.nullable(),
            })
            .strict(),
        )
        .min(1)
        .max(500),
    })
    .strict(),
  z
    .object({
      operation: z.literal('lease'),
      ...common,
      collectorId: studentUidV1,
      durationSeconds: z.number().int().min(15).max(300),
    })
    .strict(),
  z
    .object({
      operation: z.literal('collect'),
      ...write,
      collectorId: studentUidV1,
      fencingToken: version,
      sourceVersion: key,
      reportIdentity: key,
      observedAt: z.iso.datetime(),
      reportKind: z.literal('annual-detailed-collective'),
      rosterComplete: z.boolean(),
      records: z.array(sourceRecordV1).min(1).max(500),
      coverage: z.array(coverage).min(1).max(18_300),
      marks: z.array(mark).max(109_800),
    })
    .strict(),
  z
    .object({
      operation: z.literal('decide'),
      ...write,
      recordKey: key,
      studentUid: studentUidV1,
      evidenceFingerprint: key,
      decision: z.enum(['same-student', 'different-students']),
      reason: z.string().trim().min(1).max(1000),
    })
    .strict(),
]);
export type AttendanceScopeV1 = z.infer<typeof attendanceScopeV1>;
export type AttendanceRequestV1 = z.infer<typeof attendanceRequestV1>;
export type AttendanceSourceRecordV1 = z.infer<typeof sourceRecordV1>;
export type AttendanceCollectionV1 = Extract<AttendanceRequestV1, { operation: 'collect' }>;
export type AttendanceDecisionV1 = Extract<AttendanceRequestV1, { operation: 'decide' }>;
export type AttendanceConfigurationV1 = Extract<AttendanceRequestV1, { operation: 'configure' }>;

/** Trusted backend snapshot of the current annual Relação, never supplied by the collector. */
export interface AttendanceRelationStudentV1 {
  studentUid: string;
  originalName: string;
  originalClass: string;
  classId: number;
  enrollmentState?: number | null;
  relatedClassId?: number | null;
}
export interface AttendanceCandidateV1 {
  recordKey: string;
  originalName: string;
  originalClass: string;
  state: 'identified' | 'human-confirmed' | 'needs-review' | 'rejected';
  studentUid: string | null;
  candidateUids: string[];
  evidenceFingerprint: string;
}
export interface AttendanceMonthlySummaryV1 {
  month: string;
  absences: number | null;
  justified: number | null;
  datesAndLessons: { date: string; slot: number; mark: 'X' | 'J' }[];
  denominator: number | null;
  percentage: number | null;
  coverage: 'reliable' | 'incomplete';
  lastUpdated: string | null;
}

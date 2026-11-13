import { z } from 'zod';

/** Admin panel ↔ Pages ↔ notas-onedrive-sync Worker. No grades or student names ever travel here. */
export const ONEDRIVE_SYNC_CONTRACT_VERSION_V1 = 1;
export const ONEDRIVE_SYNC_BODY_BYTES_V1 = 4096;

const graphIdV1 = z.string().min(1).max(256).regex(/^[A-Za-z0-9!_.:-]+$/u);
const yearV1 = z.number().int().min(2000).max(9999);

export const oneDriveSyncRequestSchemaV1 = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('folders'), parentId: graphIdV1.nullable() }).strict(),
  z.object({ action: z.literal('preview'), folderId: graphIdV1, testWebhook: z.boolean() }).strict(),
  z.object({ action: z.literal('set-folder'), year: yearV1, folderId: graphIdV1, folderPath: z.string().min(1).max(400) }).strict(),
  z.object({ action: z.enum(['enable', 'disable', 'pause', 'resume', 'read-all']) }).strict(),
  z.object({ action: z.literal('set-wait'), seconds: z.number().int().min(0).max(600) }).strict(),
  z.object({ action: z.literal('set-parallel'), count: z.number().int().min(1).max(10) }).strict(),
  z.object({ action: z.literal('read-now'), fileId: graphIdV1 }).strict(),
]);
export type OneDriveSyncRequestV1 = z.infer<typeof oneDriveSyncRequestSchemaV1>;
export type OneDriveSyncCommandV1 = Exclude<OneDriveSyncRequestV1, { action: 'status' | 'folders' | 'preview' }>;

const outcomeV1 = z.enum(['applied', 'no-changes', 'blocked', 'rejected', 'unreadable', 'ignored', 'too-large', 'failed']);

export const oneDriveSyncFileSchemaV1 = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number(),
  modifiedAt: z.string(),
  state: z.enum(['idle', 'pending', 'reading']),
  removed: z.boolean(),
  lastOutcome: outcomeV1.nullable(),
  lastCode: z.string().nullable(),
  lastReadAt: z.number().nullable(),
  lastReadMs: z.number().nullable(),
  lastSavedToWrittenMs: z.number().nullable(),
});

export const oneDriveSyncStatusSchemaV1 = z.object({
  settings: z.object({
    enabled: z.boolean(),
    paused: z.boolean(),
    waitSeconds: z.number(),
    maxParallel: z.number(),
  }),
  activeYear: yearV1.nullable(),
  folders: z.array(z.object({
    year: yearV1, folderId: z.string(), folderPath: z.string(), setBy: z.string(), setAt: z.number(),
  })),
  breakerUntil: z.number().nullable(),
  webhook: z.object({ active: z.boolean(), expiresAt: z.string().nullable() }),
  lastDeltaAt: z.number().nullable(),
  files: z.array(oneDriveSyncFileSchemaV1),
  events: z.array(z.object({ at: z.number(), kind: z.string(), actor: z.string().nullable(), detail: z.string() })),
});
export type OneDriveSyncStatusV1 = z.infer<typeof oneDriveSyncStatusSchemaV1>;

export const oneDriveSyncFolderSchemaV1 = z.object({ id: z.string(), name: z.string(), childFolders: z.number() });

export const oneDriveSyncPreviewSchemaV1 = z.object({
  workbooks: z.number(),
  workbookBytes: z.number(),
  names: z.array(z.string()),
  sample: z.object({
    outcome: z.enum(['ready', 'blocked', 'unreadable', 'too-large', 'failed', 'none']),
    code: z.string().nullable(),
    readMs: z.number().nullable(),
    diagnostics: z.number().nullable(),
  }),
  webhook: z.object({ tested: z.boolean(), accepted: z.boolean().nullable() }),
});

export const oneDriveSyncResponseSchemaV1 = z.discriminatedUnion('state', [
  z.object({ contractVersion: z.literal(1), state: z.literal('status'), status: oneDriveSyncStatusSchemaV1 }),
  z.object({
    contractVersion: z.literal(1), state: z.literal('folders'), parentId: z.string().nullable(),
    folders: z.array(oneDriveSyncFolderSchemaV1),
  }),
  z.object({ contractVersion: z.literal(1), state: z.literal('preview'), preview: oneDriveSyncPreviewSchemaV1 }),
  z.object({ contractVersion: z.literal(1), state: z.enum(['invalid-request', 'not-authorized', 'unavailable']) }),
]);
export type OneDriveSyncResponseV1 = z.infer<typeof oneDriveSyncResponseSchemaV1>;

/** Trusted caller identity, set by the Pages route from the admin session. */
export type OneDriveSyncActorV1 = { readonly id: string; readonly name: string };

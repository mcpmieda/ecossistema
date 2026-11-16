import { vi } from 'vitest';
import type { AvatarBackfillPortsV1 } from '../../src/features/student-photos/avatar-backfill-v1';
import type { PhotoCatalogStateV1 } from '../../shared/student-photos/catalog-v1';
import type { PhotoAdminSubjectV1 } from '../../shared/student-photos/admin-http-v1';
import type { PhotoPreviewApprovalV1 } from '../../shared/student-photos/preview-v1';

export const backfillIdV1 = (n: number) => '30000000-0000-4000-8000-' + String(n).padStart(12, '0');
export const backfillSubjectV1 = (n: number): PhotoAdminSubjectV1 => ({
  source: 'portal',
  academicYear: 2026,
  accountIds: [backfillIdV1(n)],
});
/** The account a synthetic subject points to. */
export const backfillReferenceV1 = (subject: PhotoAdminSubjectV1) =>
  subject.source === 'portal' ? subject.accountIds[0] : undefined;
export const backfillStateV1 = (
  overrides: Partial<PhotoCatalogStateV1> = {},
): PhotoCatalogStateV1 => ({
  version: 1,
  studentUid: backfillIdV1(900),
  revision: backfillIdV1(800),
  initialized: true,
  hasPortrait: true,
  hasAvatar: false,
  pendingRequest: null,
  pendingKind: null,
  pendingStage: null,
  ownPending: false,
  portalReady: true,
  ...overrides,
});
export function backfillPortsV1(
  catalog: (subject: PhotoAdminSubjectV1) => Partial<PhotoCatalogStateV1> = () => ({}),
) {
  const dispose = vi.fn();
  let request = 0;
  const value = {
    catalog: vi.fn(async (who: PhotoAdminSubjectV1) => ({
      version: 1 as const,
      state: 'catalog' as const,
      traceId: backfillIdV1(700),
      canWrite: true,
      catalog: backfillStateV1(catalog(who)),
    })),
    portrait: vi.fn(async () => new Blob([new Uint8Array(64)], { type: 'image/webp' })),
    load: vi.fn(async () => ({
      image: {} as CanvasImageSource,
      src: 'blob:synthetic',
      width: 600,
      height: 800,
      dispose,
    })),
    prepare: vi.fn(async () => ({
      blob: new Blob([new Uint8Array(48).fill(7)], { type: 'image/webp' }),
      width: 320,
      height: 320,
      geometry: {
        crop: { x: 0, y: 32, width: 600, height: 600 },
        output: { width: 320, height: 320 },
      },
    })),
    client: {
      preview: vi.fn(async (_subject: PhotoAdminSubjectV1) => ({
        approval: { synthetic: 'approval' } as unknown as PhotoPreviewApprovalV1,
        images: { portrait: null, avatar: new Uint8Array(32) as Uint8Array | null },
      })),
      save: vi.fn(async (_subject: PhotoAdminSubjectV1, command: { requestId: string }) => ({
        version: 1 as const,
        traceId: backfillIdV1(701),
        state: 'committed' as const,
        requestId: command.requestId,
        revision: command.requestId,
        cleanupPending: false,
      })),
    },
    recover: vi.fn(async (_subject: PhotoAdminSubjectV1, requestId: string) => ({
      version: 1 as const,
      traceId: backfillIdV1(702),
      state: 'committed' as const,
      requestId,
      revision: requestId,
      cleanupPending: false,
    })),
    requestId: () => backfillIdV1(1000 + ++request),
  };
  return { value: value as unknown as AvatarBackfillPortsV1, spies: value, dispose };
}

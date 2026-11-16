// Synthetic, local-only proof. Never mount this handler in a published application.
import { PhotoEditServiceV1 } from '../../../server/student-photos/edit-service-v1';
import { type StudentWebpCodecV1 } from '../../../server/student-photos/webp-codec-v1';
import {
  photoWriteFingerprintV1,
  PhotoWriteErrorV1,
  type PhotoWriteReceiptV1,
} from '../../../shared/student-photos/write-v1';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error('synthetic-edit-proof-' + message);
}
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Uses the real codec/service/coordinator, with in-memory synthetic journal and
 * storage. Native PostgreSQL and Graph transport are independently exercised. */
export async function provePhotoEditV1(
  codec: StudentWebpCodecV1,
  request: Request,
): Promise<Response> {
  const body = await request.text();
  assert(body.length < 524288, 'request-budget');
  const data = JSON.parse(body) as { portrait: number[]; avatar: number[] };
  for (const values of [data.portrait, data.avatar]) {
    assert(
      Array.isArray(values) &&
        values.length >= 20 &&
        values.length <= 131072 &&
        values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255),
      'input',
    );
  }
  const input = { portrait: Uint8Array.from(data.portrait), avatar: Uint8Array.from(data.avatar) };
  const original = {
    portrait: new Uint8Array(input.portrait),
    avatar: new Uint8Array(input.avatar),
  };
  const context = {
    actorId: '10000000-0000-4000-8000-000000000001',
    studentUid: '20000000-0000-4000-8000-000000000001',
  };
  const command = {
    requestId: '30000000-0000-4000-8000-000000000001',
    expectedRevision: null,
    kind: 'replace' as const,
  };
  let receipt: PhotoWriteReceiptV1 | undefined,
    claims = 0,
    commits = 0;
  const sent: { variant: 'portrait' | 'avatar'; bytes: Uint8Array }[] = [];
  const service = new PhotoEditServiceV1({
    codec,
    authorize: async () => undefined,
    guard: { assertInitialized: async () => undefined, assertTransfer: async () => undefined },
    repository: {
      claim: async (ctx, cmd, plan) => {
        claims++;
        const inputHash = await photoWriteFingerprintV1(ctx, cmd, plan);
        if (receipt) {
          assert(receipt.inputHash === inputHash, 'receipt-mismatch');
          return receipt;
        }
        receipt = {
          ...ctx,
          ...cmd,
          inputHash,
          plan,
          phase: 'prepared',
          previous: { portrait: null, avatar: null },
          assets: { portrait: null, avatar: null },
          cleanup: [],
        };
        return receipt;
      },
      commit: async (_ctx, _id, assets) => {
        assert(receipt, 'missing-receipt');
        commits++;
        receipt = { ...receipt, assets, phase: 'committed' };
        return receipt;
      },
      acknowledgeCleanup: async () => {
        throw new Error('synthetic-unexpected-cleanup');
      },
      complete: async () => {
        assert(receipt, 'missing-receipt');
        receipt = { ...receipt, phase: 'complete' };
        return receipt;
      },
    },
    storage: (authorize) => ({
      upload: async (value) => {
        await authorize({
          kind: 'upload',
          context: value.context,
          requestId: value.requestId,
          variant: value.variant,
          metadata: value.metadata,
        });
        sent.push({ variant: value.variant, bytes: new Uint8Array(value.bytes) });
        return {
          ...value.metadata,
          driveId: 'synthetic-drive',
          itemId: value.variant,
          etag: '"synthetic"',
        };
      },
      remove: async () => {
        throw new Error('synthetic-unexpected-delete');
      },
    }),
  });
  const preview = await service.preview(
    context,
    command,
    { portrait: 92, avatar: 86 },
    input,
    request.signal,
  );
  assert(claims === 0 && sent.length === 0, 'preview-wrote');
  const wrong = structuredClone(preview.approval);
  wrong.output.avatar!.sha256 = '0'.repeat(64);
  let rejected = false;
  try {
    await service.save(context, command, wrong, input, request.signal);
  } catch (error) {
    rejected = error instanceof PhotoWriteErrorV1 && error.code === 'conflict';
  }
  assert(rejected && claims === 0 && sent.length === 0, 'changed-output-not-rejected');
  const saved = await service.save(context, command, preview.approval, input, request.signal);
  assert(saved.state === 'committed' && !saved.cleanupPending, 'not-committed');
  await service.save(context, command, preview.approval, input, request.signal);
  assert(Number(claims) === 2 && commits === 1 && Number(sent.length) === 2, 'duplicate-write');
  for (const value of sent) {
    const expected = preview.images[value.variant];
    assert(expected && same(value.bytes, expected), 'preview-save-mismatch');
  }
  assert(
    same(input.portrait, original.portrait) && same(input.avatar, original.avatar),
    'caller-mutated',
  );
  return Response.json({
    state: 'passed',
    claims,
    commits,
    uploads: sent.length,
    changedPreviewRejected: rejected,
    portrait: Array.from(preview.images.portrait!),
    avatar: Array.from(preview.images.avatar!),
    output: preview.approval.output,
  });
}

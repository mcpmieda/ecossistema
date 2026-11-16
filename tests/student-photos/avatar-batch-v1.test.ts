// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  PHOTO_AVATAR_BATCH_MAX_V1,
  decodePhotoAvatarBatchV1,
  encodePhotoAvatarBatchV1,
  photoAvatarBatchRequestV1,
  type PhotoAvatarBatchItemV1,
} from '../../shared/student-photos/avatar-batch-v1';
import {
  readAvatarBatchV1,
  type AvatarBatchFamilyV1,
} from '../../server/student-photos/avatar-batch-service-v1';
import { PhotoCatalogRepositoryV1 } from '../../server/student-photos/catalog-repository-v1';
import type { PhotoWriteDatabaseV1 } from '../../server/student-photos/write-repository-v1';
import type { PhotoAdminSubjectV1 } from '../../shared/student-photos/admin-http-v1';
import type { PhotoAssetV1 } from '../../shared/student-photos/write-v1';

const account = (n: number) => '40000000-0000-4000-8000-' + String(n).padStart(12, '0');
const uid = (n: number) => '50000000-0000-4000-8000-' + String(n).padStart(12, '0');
const subject = (n: number): PhotoAdminSubjectV1 => ({
  source: 'portal',
  academicYear: 2026,
  accountIds: [account(n)],
});
const bytes = (fill: number, length = 40) => new Uint8Array(length).fill(fill);
const asset = (n: number, variant: 'portrait' | 'avatar' = 'avatar'): PhotoAssetV1 => ({
  driveId: 'student-photos',
  itemId: `legacy/${uid(n)}/${variant}-${String(n).padStart(64, 'a')}.webp`,
  etag: String(n).padStart(64, 'a'),
  sha256: String(n).padStart(64, 'a'),
  byteSize: 40,
  width: 320,
  height: variant === 'avatar' ? 320 : 427,
});
const signal = () => new AbortController().signal;

describe('transport of several avatars', () => {
  it('returns each entry in order, with absence and unavailability kept apart', () => {
    const items: PhotoAvatarBatchItemV1[] = [bytes(1), null, 'unavailable', bytes(2, 131072)];
    const encoded = encodePhotoAvatarBatchV1(items);
    expect(decodePhotoAvatarBatchV1(encoded.buffer as ArrayBuffer, 4)).toEqual(items);
  });

  it('rejects another count, truncation, padding, an oversized image and a foreign format', () => {
    const encoded = encodePhotoAvatarBatchV1([bytes(1), null]);
    const copy = (change: (value: Uint8Array) => Uint8Array) =>
      change(new Uint8Array(encoded)).buffer as ArrayBuffer;
    expect(() =>
      decodePhotoAvatarBatchV1(
        copy((value) => value),
        3,
      ),
    ).toThrow();
    expect(() =>
      decodePhotoAvatarBatchV1(
        copy((value) => value.slice(0, value.length - 1)),
        2,
      ),
    ).toThrow();
    expect(() =>
      decodePhotoAvatarBatchV1(
        copy((value) => Uint8Array.from([...value, 0])),
        2,
      ),
    ).toThrow();
    expect(() =>
      decodePhotoAvatarBatchV1(
        copy((value) => {
          value[0] = 0;
          return value;
        }),
        2,
      ),
    ).toThrow();
    expect(() =>
      decodePhotoAvatarBatchV1(
        copy((value) => {
          new DataView(value.buffer).setUint32(5, 500_000);
          return value;
        }),
        2,
      ),
    ).toThrow();
    expect(() => encodePhotoAvatarBatchV1([])).toThrow();
    expect(() => encodePhotoAvatarBatchV1([bytes(1, 131073)])).toThrow();
    expect(() =>
      encodePhotoAvatarBatchV1(Array.from({ length: PHOTO_AVATAR_BATCH_MAX_V1 + 1 }, () => null)),
    ).toThrow();
  });

  it('accepts one to sixteen distinct students and nothing else', () => {
    const request = (subjects: unknown[]) =>
      photoAvatarBatchRequestV1.safeParse({ version: 1, subjects }).success;
    expect(
      request([subject(1), { source: 'gradebook', academicYear: 2026, studentIds: [7] }]),
    ).toBe(true);
    expect(request([])).toBe(false);
    expect(request([subject(1), subject(1)])).toBe(false);
    expect(request(Array.from({ length: 17 }, (_, index) => subject(index + 1)))).toBe(false);
    expect(
      request([{ source: 'portal', academicYear: 2026, accountIds: [account(1), account(2)] }]),
    ).toBe(false);
    expect(
      photoAvatarBatchRequestV1.safeParse({ version: 1, subjects: [subject(1)], extra: true })
        .success,
    ).toBe(false);
  });
});

describe('joint avatar read', () => {
  function ports(families: (AvatarBatchFamilyV1 | null)[], after = families) {
    const trace: string[] = [];
    let call = 0;
    return {
      trace,
      value: {
        authorize: vi.fn(async () => {
          trace.push('authorize');
        }),
        families: vi.fn(async () => {
          trace.push('families');
          return call++ === 0 ? families : after;
        }),
        read: vi.fn(async (item: PhotoAssetV1) => {
          trace.push('read');
          return bytes(Number(item.sha256.slice(-2)));
        }),
      },
    };
  }

  it('checks access before the catalog and again after Storage, and reads only who has an image', async () => {
    const { value, trace } = ports([
      { uid: uid(1), asset: asset(11) },
      null,
      { uid: uid(3), asset: null },
      { uid: uid(4), asset: asset(14, 'portrait') },
    ]);
    const result = await readAvatarBatchV1([1, 2, 3, 4].map(subject), value, signal());
    expect(result).toEqual([bytes(11), null, null, bytes(14)]);
    expect(trace).toEqual(['authorize', 'families', 'read', 'read', 'authorize', 'families']);
    expect(value.read.mock.calls.map(([item]) => item.itemId)).toEqual([
      asset(11).itemId,
      asset(14, 'portrait').itemId,
    ]);
  });

  it('returns nothing readable for a student whose reference or photo changed during the read', async () => {
    const before = [
      { uid: uid(1), asset: asset(11) },
      { uid: uid(2), asset: asset(12) },
      { uid: uid(3), asset: asset(13) },
      { uid: uid(4), asset: asset(14) },
    ];
    const after = [
      before[0]!,
      { uid: uid(9), asset: asset(12) },
      { uid: uid(3), asset: asset(23) },
      null,
    ];
    const { value } = ports(before, after);
    expect(await readAvatarBatchV1([1, 2, 3, 4].map(subject), value, signal())).toEqual([
      bytes(11),
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
  });

  it("keeps one student's Storage failure from the others and never answers after access is lost", async () => {
    const families = [
      { uid: uid(1), asset: asset(11) },
      { uid: uid(2), asset: asset(12) },
    ];
    const failing = ports(families);
    failing.value.read.mockImplementationOnce(async () => {
      throw new Error('synthetic-storage');
    });
    expect(await readAvatarBatchV1([1, 2].map(subject), failing.value, signal())).toEqual([
      'unavailable',
      bytes(12),
    ]);

    const denied = ports(families);
    const read: Uint8Array[] = [];
    denied.value.read.mockImplementation(async () => {
      const value = bytes(9);
      read.push(value);
      return value;
    });
    denied.value.authorize
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('synthetic-denied'));
    await expect(readAvatarBatchV1([1, 2].map(subject), denied.value, signal())).rejects.toThrow(
      'synthetic-denied',
    );
    expect(read.every((value) => value.every((byte) => byte === 0))).toBe(true);

    const early = ports(families);
    early.value.authorize.mockRejectedValueOnce(new Error('synthetic-denied'));
    await expect(readAvatarBatchV1([1, 2].map(subject), early.value, signal())).rejects.toThrow(
      'synthetic-denied',
    );
    expect(early.value.families).not.toHaveBeenCalled();
    expect(early.value.read).not.toHaveBeenCalled();
  });
});

describe('catalog lookup for several students', () => {
  it('resolves every subject in one statement and chooses the avatar, or the portrait while there is none', async () => {
    const query = vi.fn(async (sql: string, parameters: readonly unknown[] = []) => {
      if (sql.includes('set_config')) return [];
      expect(sql).toContain('student_photos.resolve_student_v1');
      expect(JSON.parse(String(parameters[0]))).toEqual([
        { ord: 0, source: 'portal', year: 2026, reference: account(1) },
        { ord: 1, source: 'gradebook', year: 2026, reference: '7' },
        { ord: 2, source: 'portal', year: 2026, reference: account(3) },
        { ord: 3, source: 'portal', year: 2026, reference: account(4) },
      ]);
      return [
        { ord: 0, uid: uid(1), assets: { portrait: asset(21, 'portrait'), avatar: asset(11) } },
        { ord: 1, uid: uid(2), assets: { portrait: asset(22, 'portrait'), avatar: null } },
        { ord: 2, uid: null, assets: null },
        { ord: 3, uid: uid(4), assets: null },
      ];
    });
    const database: PhotoWriteDatabaseV1 = { transaction: (work) => work({ query }) };
    const repository = new PhotoCatalogRepositoryV1(database);
    const result = await repository.avatarFamilies([
      subject(1),
      { source: 'gradebook', academicYear: 2026, studentIds: [7] },
      subject(3),
      subject(4),
    ]);
    expect(result).toEqual([
      { uid: uid(1), asset: asset(11) },
      { uid: uid(2), asset: asset(22, 'portrait') },
      null,
      { uid: uid(4), asset: null },
    ]);
    expect(query.mock.calls.filter(([sql]) => !sql.includes('set_config'))).toHaveLength(1);
  });

  it('refuses an answer that does not match the request row by row', async () => {
    const database: PhotoWriteDatabaseV1 = {
      transaction: (work) =>
        work({
          query: async (sql: string) =>
            sql.includes('set_config') ? [] : [{ ord: 1, uid: uid(1), assets: null }],
        }),
    };
    await expect(
      new PhotoCatalogRepositoryV1(database).avatarFamilies([subject(1)]),
    ).rejects.toThrow('student-photo-write-invalid');
    await expect(new PhotoCatalogRepositoryV1(database).avatarFamilies([])).rejects.toThrow();
  });
});

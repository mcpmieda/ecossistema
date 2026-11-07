import { qrUrlV1 } from '../../../../shared/student-portal-contracts/auth-v1';

export class QrInputErrorV1 extends Error {
  constructor(
    readonly reason: 'invalid' | 'absent' | 'multiple' | 'large' | 'unsupported' | 'unavailable',
  ) {
    super(reason);
    this.name = 'QrInputErrorV1';
  }
}
export function validateStudentQrV1(value: string): string {
  const parsed = qrUrlV1.safeParse(value);
  if (!parsed.success) throw new QrInputErrorV1('invalid');
  return parsed.data;
}
/** Call once in the entrypoint, before rendering or loading external scripts. Never persist the result. */
export function consumeStudentQrLocationV1(
  location: Pick<Location, 'href' | 'pathname' | 'hash'>,
  history: Pick<History, 'replaceState'>,
): string | null {
  if (location.pathname !== '/access' || !location.hash) return null;
  const candidate = location.href;
  // Remove even malformed credentials; do not copy the previous history state.
  history.replaceState(null, '', '/access');
  return validateStudentQrV1(candidate);
}
export function selectStudentQrV1(codes: readonly string[]): string {
  if (codes.length === 0) throw new QrInputErrorV1('absent');
  if (codes.length !== 1) throw new QrInputErrorV1('multiple');
  return validateStudentQrV1(codes[0]!);
}

const QR_IMAGE_MAX_BYTES_V1 = 10 * 1024 * 1024;
export const QR_IMAGE_MAX_PIXELS_V1 = 16 * 1024 * 1024;
export function validateQrImageFileV1(file: Pick<File, 'size' | 'type'>) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw new QrInputErrorV1('unsupported');
  if (file.size <= 0 || file.size > QR_IMAGE_MAX_BYTES_V1) throw new QrInputErrorV1('large');
}

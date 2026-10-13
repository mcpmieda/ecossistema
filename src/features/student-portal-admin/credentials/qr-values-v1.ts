import { z } from 'zod';
import { printCardV1 } from '../../../../shared/student-portal-contracts/admin-v1';
export type PrintCardV1 = z.infer<typeof printCardV1>;
export type PrintModeV1 = PrintCardV1['mode'];
export type QrArtifactV1 = { blob: Blob; format: 'pdf' | 'png'; count: number; pages: number };
export const PRINT_MODES_V1: Record<PrintModeV1, string> = {
  'qr-only': 'Somente QR',
  'qr-name': 'QR + nome',
  'qr-name-class': 'QR + nome + turma',
};
export class QrArtifactErrorV1 extends Error {
  constructor(readonly kind: 'invalid-cards' | 'render-unavailable' | 'text-does-not-fit') {
    super('portal-qr-artifact-' + kind);
  }
}
export function validatePrintCardsV1(input: unknown): PrintCardV1[] {
  const parsed = z.array(printCardV1).min(1).max(100).safeParse(input);
  if (!parsed.success) throw new QrArtifactErrorV1('invalid-cards');
  return validatePrintCardCollectionV1(parsed.data);
}
/** A PDF can aggregate independently validated response chunks without limiting the class. */
export function validatePrintCardCollectionV1(input: unknown): PrintCardV1[] {
  const parsed = z.array(printCardV1).min(1).safeParse(input);
  if (
    !parsed.success ||
    new Set(parsed.data.map((c) => c.accountId.toLowerCase())).size !== parsed.data.length ||
    new Set(parsed.data.map((c) => c.qr)).size !== parsed.data.length ||
    parsed.data.some((c) => c.mode !== parsed.data[0]!.mode)
  )
    throw new QrArtifactErrorV1('invalid-cards');
  return parsed.data;
}

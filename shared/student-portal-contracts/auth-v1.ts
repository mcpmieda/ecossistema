import { z } from 'zod';
import { instantV1, opaqueV1, portalIdV1, PORTAL_ORIGIN_V1 } from './core-v1';

export const pinV1 = z.string().regex(/^\d{4}$/u);
export const passwordV1 = z.string().regex(/^\d{6}$/u);
/**
 * Easy-to-guess passwords are refused when one is created (owner decision 28/09/2026): all digits
 * equal (111111), a straight run up or down (123456, 654321) or a repeated pair or trio (121212,
 * 123123, 112233). Signing in is never checked, so passwords created before keep working.
 */
export function isWeakPasswordV1(password: string): boolean {
  if (!/^\d{6}$/u.test(password)) return false;
  const digits = [...password].map(Number);
  const steps = digits.slice(1).map((digit, index) => digit - digits[index]!);
  if (steps.every((step) => step === 0)) return true;
  if (steps.every((step) => step === 1) || steps.every((step) => step === -1)) return true;
  if (password.slice(0, 2).repeat(3) === password || password.slice(0, 3).repeat(2) === password) return true;
  return digits[0] === digits[1] && digits[2] === digits[3] && digits[4] === digits[5];
}
export const newPasswordV1 = passwordV1.refine((value) => !isWeakPasswordV1(value), 'Weak password');
export const qrPayloadV1 = z.object({
  formatVersion: z.literal(1), credentialId: opaqueV1, keyVersion: z.number().int().positive(), signature: opaqueV1,
}).strict();
export const qrUrlV1 = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.origin === PORTAL_ORIGIN_V1 && url.pathname === '/access' && !url.username && !url.password &&
      !url.search && /^#v1\.[A-Za-z0-9_-]{32,128}\.[1-9]\d{0,5}\.[A-Za-z0-9_-]{43}$/u.test(url.hash);
  } catch { return false; }
}, 'Expected a Portal V1 credential URL');
const input = { contractVersion: z.literal(1) };
export const challengeRequestV1 = z.object({ ...input, qr: qrUrlV1, pin: pinV1.optional(), riskToken: z.string().min(1).max(2048).optional() }).strict();
export const activateRequestV1 = z.object({
  ...input, challenge: opaqueV1, password: newPasswordV1, confirmation: passwordV1, keepConnected: z.boolean(),
}).strict().refine((v) => v.password === v.confirmation, { path: ['confirmation'], message: 'Confirmation mismatch' });
export const loginRequestV1 = z.object({
  ...input, qr: qrUrlV1, password: passwordV1, keepConnected: z.boolean(), riskToken: z.string().min(1).max(2048).optional(),
}).strict();
export const logoutRequestV1 = z.object(input).strict();
export const challengeResponseV1 = z.discriminatedUnion('state', [
  z.object({ ...input, requestId: portalIdV1, state: z.literal('credential-required'), next: z.enum(['pin', 'password', 'risk']) }).strict(),
  z.object({ ...input, requestId: portalIdV1, state: z.literal('password-creation'), challenge: opaqueV1, expiresAt: instantV1 }).strict(),
]);
export const sessionResponseV1 = z.object({ ...input, requestId: portalIdV1, state: z.literal('authenticated'), expiresAt: instantV1, persistent: z.boolean(), liveRenewed: z.boolean().optional() }).strict();
export const logoutResponseV1 = z.object({ ...input, requestId: portalIdV1, state: z.literal('logged-out') }).strict();
export const SESSION_COOKIE_V1 = { name: '__Host-student_portal_session', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' } as const;
export const ACCESS_CLOSED_ACCEPT_HEADER_V1 = 'X-Student-Portal-Access-Status';
export const AUTH_BODY_BYTES_V1 = 8192;
export type ActivateRequestV1 = z.infer<typeof activateRequestV1>;

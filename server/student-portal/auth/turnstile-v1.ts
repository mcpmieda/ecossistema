import { z } from 'zod';
import { emitPortalRiskVerifyMetricV1, PORTAL_RISK_CODES_V1, type PortalRiskVerifyMetricV1 } from '../observability/metrics-v1';

export const TURNSTILE_ACTION_V1 = 'student_portal_auth';
export interface RiskVerifierV1 { verify(token: string): Promise<boolean> }

// Cloudflare answers a refused token with 200 or 400 and these codes: the family solves the check
// again. Any other code (the secret, a malformed request, Cloudflare's own failure) is ours.
const TOKEN_CODES_V1 = new Set(['missing-input-response', 'invalid-input-response', 'timeout-or-duplicate']);
const answerV1 = z.object({ success: z.boolean(), hostname: z.string().nullish(), action: z.string().nullish(),
  'error-codes': z.array(z.string()).nullish() });
type RiskSinkV1 = (metric: PortalRiskVerifyMetricV1) => void;
const codeOfV1 = (codes: readonly string[]): PortalRiskVerifyMetricV1['code'] => {
  const known = codes.find((code) => (PORTAL_RISK_CODES_V1 as readonly string[]).includes(code));
  if (known) return known as PortalRiskVerifyMetricV1['code'];
  return codes.length ? 'other' : null;
};

/** No caller-supplied endpoint/hostname, IP identity, caching or token logging. */
export class TurnstileVerifierV1 implements RiskVerifierV1 {
  constructor(private readonly secret: string, private readonly fetcher: typeof fetch = fetch,
    private readonly emit: RiskSinkV1 = emitPortalRiskVerifyMetricV1) {
    if (!secret) throw new Error('student-portal-risk-unavailable');
  }
  async verify(token: string): Promise<boolean> {
    if (!z.string().min(1).max(2048).safeParse(token).success) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let status = 0;
    try {
      const response = await this.fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        // Workers rejects redirect=error before the subrequest. Manual mode
        // prevents the secret from following a redirect; a 3xx stays fail-closed below.
        method: 'POST', redirect: 'manual', signal: controller.signal,
        body: new URLSearchParams({ secret: this.secret, response: token }),
      });
      status = response.status;
      if (status !== 200 && status !== 400) {
        this.emit({ event: 'student-portal-risk-verify-v1', outcome: 'unavailable', status, code: null });
        throw new Error('student-portal-risk-unavailable');
      }
      const result = answerV1.parse(await response.json());
      const codes = result['error-codes'] ?? [];
      const code = codeOfV1(codes);
      if (result.success && status === 200) {
        const passed = result.hostname === 'aluno.escolaieda.com' && result.action === TURNSTILE_ACTION_V1;
        this.emit({ event: 'student-portal-risk-verify-v1', outcome: passed ? 'passed' : 'rejected', status, code });
        return passed;
      }
      // A spent, expired or broken token: ask for the check again instead of "unavailable".
      if (!result.success && (codes.length > 0 || status === 200) && codes.every((item) => TOKEN_CODES_V1.has(item))) {
        this.emit({ event: 'student-portal-risk-verify-v1', outcome: 'rejected', status, code });
        return false;
      }
      this.emit({ event: 'student-portal-risk-verify-v1', outcome: 'unavailable', status, code });
      throw new Error('student-portal-risk-unavailable');
    } catch (error) {
      if (error instanceof Error && error.message === 'student-portal-risk-unavailable') throw error;
      // Transport, timeout or a body that is not the expected JSON; never serialized to the family.
      this.emit({ event: 'student-portal-risk-verify-v1', outcome: 'unavailable', status, code: null });
      throw new Error('student-portal-risk-unavailable', { cause: error });
    } finally { clearTimeout(timer); }
  }
}

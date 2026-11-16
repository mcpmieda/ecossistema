import { z } from 'zod';
import { TurnstileVerifierV1 } from '../../../server/student-portal/auth/turnstile-v1';

/** Explicit live proof only, not an implicit network dependency of verify/CI.
 * These are Cloudflare's public testing keys, not production secrets.
 */
export async function proveTurnstileProviderV1() {
  const pass = '1x0000000000000000000000000000000AA';
  const spent = '3x0000000000000000000000000000000AA';
  const dummy = 'XXXX.DUMMY.TOKEN.XXXX';
  const schema = z.object({ success: z.boolean(), 'error-codes': z.array(z.string()).optional() });
  const siteverify = async (secret: string) => {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      body: new URLSearchParams({ secret, response: dummy }),
    });
    if (!response.ok) throw new Error('provider-proof-unavailable');
    return schema.parse(await response.json());
  };
  const accepted = await siteverify(pass);
  const replay = await siteverify(spent);
  const strictRejected = !(await new TurnstileVerifierV1(pass).verify(dummy));
  if (
    !accepted.success ||
    replay.success ||
    !replay['error-codes']?.includes('timeout-or-duplicate') ||
    !strictRejected
  )
    throw new Error('provider-proof-failed');
  return {
    publicDummyAccepted: true,
    providerSpentFixtureRejected: true,
    strictProductionHostnameActionRejectedDummy: true,
  };
}

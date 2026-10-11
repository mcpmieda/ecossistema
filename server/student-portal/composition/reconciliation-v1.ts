import { trustedAdminContextV1 } from '../../../shared/student-portal-contracts/admin-v1';
import {
  prepareReconciliationCredentialsV1,
  reconciliationCredentialRequestV1,
} from '../birth-year/reconciliation-credentials-v1';
import { limitAdminOperationV1 } from './admin-rate-limit-v1';
import { portalKeysV1, type PortalCompositionEnvV1 } from './config-v1';
import { portalDatabaseV1 } from './database-v1';
import { portalFailureV1 } from '../runtime/http-v1';

/** Named internal capability only; this operation is never a public Portal command. */
export async function portalReconciliationCredentialsRpcV1(
  env: PortalCompositionEnvV1,
  context: unknown,
  input: unknown,
) {
  const trusted = trustedAdminContextV1.safeParse(context);
  if (!trusted.success) return portalFailureV1('forbidden');
  const fail = (state: 'forbidden' | 'invalid-request' | 'unavailable') => ({
    ...portalFailureV1(state),
    requestId: trusted.data.requestId,
  });
  const age = Date.now() - Date.parse(trusted.data.authenticatedAt);
  if (
    env.PORTAL_ENVIRONMENT !== 'production' ||
    trusted.data.tenantId.toLowerCase() !== env.PORTAL_ADMIN_TENANT_ID.toLowerCase() ||
    trusted.data.capability !== 'platform.settings.write' ||
    age < 0 ||
    age > 300_000
  )
    return fail('forbidden');
  const request = reconciliationCredentialRequestV1.safeParse(input);
  if (!request.success) return fail('invalid-request');
  if (env.PORTAL_SERVING_ENABLED !== 'true') return fail('unavailable');
  const limited = await limitAdminOperationV1(env, trusted.data, 'import');
  if (limited) return limited;
  try {
    const keys = portalKeysV1(env);
    return await portalDatabaseV1(env, 'admin-command', (sql) =>
      prepareReconciliationCredentialsV1(
        sql,
        keys.cryptoPort,
        keys.pepperVersion,
        trusted.data.actorId,
        request.data,
      ),
    );
  } catch {
    return fail('unavailable');
  }
}

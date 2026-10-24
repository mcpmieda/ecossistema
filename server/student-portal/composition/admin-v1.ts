import { adminCommandOperationV1, limitAdminOperationV1 } from './admin-rate-limit-v1';
import { portalLiveStubV1 } from '../live/live-connect-v1';
import { adminResponseV1, adminCommandV1, trustedAdminContextV1  } from '../../../shared/student-portal-contracts/admin-v1';

import { adminQueryRequestV2 } from '../../../shared/student-portal-contracts/admin-read-v2';
import { PortalAdminApiV1 } from '../admin/api-v1';
import { withAuditSqlV1 } from '../observability/audit-context-v1';
import { scopedPublicationEnabledV2 } from '../publication/scoped-source-v2';
import { portalFailureV1 } from '../runtime/http-v1';
import { portalKeysV1, type PortalCompositionEnvV1 } from './config-v1';
import { portalDatabaseV1 } from './database-v1';

/** Invoked exclusively by the named RPC capability; never dispatched from public HTTP. */
export async function portalAdminRpcV1(env: PortalCompositionEnvV1, kind: 'query' | 'command', context: unknown, input: unknown) {
  const trusted = trustedAdminContextV1.safeParse(context);
  if (!trusted.success) return portalFailureV1('forbidden');
  const fail = (state: 'forbidden' | 'invalid-request' | 'unavailable') => ({ ...portalFailureV1(state), requestId: trusted.data.requestId });
  const age = Date.now() - Date.parse(trusted.data.authenticatedAt);
  if (env.PORTAL_ENVIRONMENT !== 'production' || trusted.data.tenantId.toLowerCase() !== env.PORTAL_ADMIN_TENANT_ID.toLowerCase()
    || age < 0 || age > 300_000 || (kind === 'command' && trusted.data.capability !== 'platform.settings.write')) return fail('forbidden');
  const parsed = kind === 'query' ? adminQueryRequestV2.safeParse(input) : adminCommandV1.safeParse(input);
  if (!parsed.success) return fail('invalid-request');
  if (env.PORTAL_SERVING_ENABLED !== 'true' && !(kind === 'query' && parsed.data.operation === 'health')) return fail('unavailable');
  const limited = await limitAdminOperationV1(env, trusted.data, kind === 'query' ? 'read' : adminCommandOperationV1(parsed.data.operation));
  if (limited) return limited;
  try {
    if (kind === 'query' && parsed.data.operation === 'presence') {
      const result = await portalLiveStubV1(env, 'student').presence(parsed.data.scope);
      return adminResponseV1.parse({ contractVersion: 1, requestId: trusted.data.requestId, state: 'presence', ...result });
    }
    const keys = portalKeysV1(env);
    return await portalDatabaseV1(env, kind === 'query' ? 'admin-query' : 'admin-command', async (sql) => {
      const capable = env.PORTAL_PUBLICATION_MODE === 'scoped-v2';
      const scopedPublication = capable && await scopedPublicationEnabledV2(sql);
      // V2 reads set isolation before their first query; the audit wrapper stays on every V1 command.
      return new PortalAdminApiV1(kind === 'query' && (parsed.data.contractVersion === 2 || parsed.data.operation === 'bulk-preview') ? sql : withAuditSqlV1(sql, trusted.data.clientIp ?? null, trusted.data),
        { ...keys, tenantId: env.PORTAL_ADMIN_TENANT_ID, scopedPublication })[kind](trusted.data, parsed.data);
    });
  } catch { return fail('unavailable'); }
}

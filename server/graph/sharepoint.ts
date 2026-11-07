import type { RuntimeEnv } from '../env';
import { graphRequest } from './client';
import type { GraphCredentialSlot } from '../auth/technical-identity';

export async function sharePointHealth(
  env: RuntimeEnv,
  credentialSlot?: GraphCredentialSlot,
): Promise<{ status: 'ok'; listCount: number; correlationId: string }> {
  const result = await graphRequest<{ value: Array<{ id: string }> }>({
    env,
    path: `/sites/${env.SHAREPOINT_SITE_ID}/lists?$select=id&$top=20`,
    credentialSlot,
  });
  return { status: 'ok', listCount: result.data.value.length, correlationId: result.correlationId };
}

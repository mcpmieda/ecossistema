import { notifyLiveChangeV1 } from '../../../shared/live-data/live-refresh-v1';
import {
  relationalCouncilRequestSchemaV3,
  relationalCouncilResponseMatchesV3,
  relationalCouncilResponseSchemaV3,
  type RelationalCouncilRequestV3,
  type RelationalCouncilResponseV3,
} from '../../../../shared/gradebook-contracts/council/relational-council-v3';

export async function requestRelationalCouncilV3(
  request: RelationalCouncilRequestV3,
  signal?: AbortSignal,
): Promise<RelationalCouncilResponseV3> {
  if (!relationalCouncilRequestSchemaV3.safeParse(request).success) {
    return { contractVersion: 3, state: 'invalid-request' };
  }
  const response = await fetch('/api/gradebook/council-workspace', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(request),
  });
  if (response.status === 401 || response.status === 403)
    return { contractVersion: 3, state: 'not-authorized' };
  const unavailable = { contractVersion: 3, state: 'unavailable' } as const;
  if (Number(response.headers.get('content-length')) > 4_000_000) return unavailable;
  const body = await response.text();
  if (body.length > 4_000_000) return unavailable;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return unavailable;
  }
  const parsed = relationalCouncilResponseSchemaV3.safeParse(value);
  if (!parsed.success || !relationalCouncilResponseMatchesV3(request, parsed.data))
    return unavailable;
  if (!response.ok && parsed.data.state === 'ready') return unavailable;
  if (
    parsed.data.state === 'ready' &&
    request.operation !== 'classes' &&
    request.operation !== 'workspace'
  )
    notifyLiveChangeV1('gradebook');
  return parsed.data;
}

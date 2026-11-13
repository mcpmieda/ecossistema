import {
  ONEDRIVE_SYNC_CONTRACT_VERSION_V1,
  oneDriveSyncRequestSchemaV1,
  oneDriveSyncResponseSchemaV1,
  type OneDriveSyncRequestV1,
  type OneDriveSyncResponseV1,
} from '../../../../shared/gradebook-contracts/onedrive-sync/onedrive-sync-contract-v1';

const ENDPOINT = '/api/gradebook/onedrive-sync';

function fallback(state: 'invalid-request' | 'not-authorized' | 'unavailable'): OneDriveSyncResponseV1 {
  return { contractVersion: ONEDRIVE_SYNC_CONTRACT_VERSION_V1, state };
}

export async function requestOneDriveSyncV1(request: OneDriveSyncRequestV1, signal?: AbortSignal): Promise<OneDriveSyncResponseV1> {
  if (!oneDriveSyncRequestSchemaV1.safeParse(request).success) return fallback('invalid-request');
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return fallback('unavailable');
  }
  if (response.status === 401 || response.status === 403) return fallback('not-authorized');
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return fallback('unavailable');
  }
  const parsed = oneDriveSyncResponseSchemaV1.safeParse(value);
  return parsed.success ? parsed.data : fallback('unavailable');
}

import { noStoreResponseV1 } from '../../http/security';

/** A request that is not JSON (400), or one in a retired contract version (410), never read further. */
export function retiredGradebookRequestV1(payload: unknown): Response {
  const isObject = payload !== null && typeof payload === 'object' && !Array.isArray(payload);
  return isObject
    ? noStoreResponseV1(JSON.stringify({ state: 'retired' }), 410, 'application/json; charset=utf-8')
    : noStoreResponseV1(null, 400);
}

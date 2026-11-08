/** A request that is not JSON (400), or one in a retired contract version (410), never read further. */
export function retiredGradebookRequestV1(payload: unknown): Response {
  const isObject = payload !== null && typeof payload === 'object' && !Array.isArray(payload);
  return new Response(isObject ? JSON.stringify({ state: 'retired' }) : null, {
    status: isObject ? 410 : 400,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Expires: '0',
      Pragma: 'no-cache',
      ...(isObject ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    },
  });
}

/** Delete only this proof's random service; never force dependencies or inspect KV. */
export async function deletePortalProof(
  state: { name: string; runId: string },
  account: string | undefined,
  token: string | undefined,
  request: typeof fetch = fetch,
): Promise<void> {
  if (
    !/^[a-f0-9]{32}$/.test(state.runId) ||
    state.name !== `student-portal-proof-${state.runId.slice(0, 12)}` ||
    account !== '40cef24b2a2a1df8ab3d974dcafb2c03' ||
    !token
  )
    throw new Error('invalid-proof-cleanup');
  const response = await request(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/services/${state.name}?force=false`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  // A proxy or outage may answer with HTML or an empty body; keep the HTTP status visible.
  const result = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    errors?: { code?: number }[];
  };
  if (response.ok && result.success) return;
  // A previous cleanup may have completed before its runner was interrupted.
  if (response.status === 404 && result.errors?.some((error) => error.code === 10007)) return;
  throw new Error(`proof-cleanup-failed:${response.status}`);
}

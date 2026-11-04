// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { deletePortalProof } from '../../../workers/student-portal/proof-cleanup.ts';

const account = '40cef24b2a2a1df8ab3d974dcafb2c03';
const state = {
  name: 'student-portal-proof-1234567890ab',
  runId: '1234567890abcdef1234567890abcdef',
};
describe('temporary proof cleanup boundary', () => {
  it('deletes only the owned service without forced deletion or KV operations', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true }));
    await deletePortalProof(state, account, 'synthetic-token', request);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/services/${state.name}?force=false`,
    );
    expect(request.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });
  it('refuses production names and other accounts before making a request', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(
      deletePortalProof(
        { ...state, name: 'student-portal-production' },
        account,
        'synthetic',
        request,
      ),
    ).rejects.toThrow('invalid-proof-cleanup');
    await expect(deletePortalProof(state, 'another-account', 'synthetic', request)).rejects.toThrow(
      'invalid-proof-cleanup',
    );
    expect(request).not.toHaveBeenCalled();
  });
  it('accepts already absent resources but does not hide permission errors', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ errors: [{ code: 10007 }] }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ errors: [{ code: 10000 }] }, { status: 403 }));
    await expect(deletePortalProof(state, account, 'synthetic', request)).resolves.toBeUndefined();
    await expect(deletePortalProof(state, account, 'synthetic', request)).rejects.toThrow(
      'proof-cleanup-failed:403',
    );
  });
  it('reports the HTTP status when the API answers with a non-JSON body', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html>Service Unavailable</html>', { status: 503 }));
    await expect(deletePortalProof(state, account, 'synthetic', request)).rejects.toThrow(
      'proof-cleanup-failed:503',
    );
  });
});

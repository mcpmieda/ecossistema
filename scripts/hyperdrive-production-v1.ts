import process from 'node:process';
import { pathToFileURL } from 'node:url';

const configurations = [
  { name: 'gradebook', id: '476b417597c84b4c994bd36f1a65cb70', role: 'gradebook_app', maximum: 20 },
  { name: 'portal', id: '46ac2fcb25ad4ad5b5662d536ccd968a', role: 'student_portal_app', maximum: 8 },
] as const;
type Name = typeof configurations[number]['name'];
type Configuration = { caching?: { disabled?: boolean }; origin_connection_limit?: number;
  origin?: { user?: string; host?: string; database?: string } };
export type HyperdriveCheckV1 = { name: Name; state: 'verified' | 'updated' | 'permission-required' | 'unavailable' | 'unexpected-origin';
  cacheDisabled?: boolean; originConnections?: number };

/** A narrow patch only: no origin, credential, TLS, route, binding or pool restart changes. */
export function hyperdrivePatchV1(name: Name, current: Configuration) {
  const target = configurations.find((item) => item.name === name)!;
  const role = current.origin?.user;
  if (role !== target.role && role !== `${target.role}.knzzyqgafdkwzjmdrfea`)
    throw new Error('Unexpected Hyperdrive origin role');
  const limit = current.origin_connection_limit;
  if (!Number.isInteger(limit) || limit! < 5) throw new Error('Unknown Hyperdrive connection limit');
  const desired = Math.min(limit!, target.maximum);
  return { caching: { disabled: true }, origin_connection_limit: desired };
}
type HyperdriveTargetV1 = (typeof configurations)[number];
type HyperdriveRequestV1 = { fetcher: typeof fetch; headers: Record<string, string> };

/** One configuration: read, compare, and (with apply) patch and confirm with a separate read. */
async function checkHyperdriveV1(
  target: HyperdriveTargetV1,
  context: HyperdriveRequestV1 & { accountId: string; apply: boolean },
): Promise<HyperdriveCheckV1> {
  const { fetcher, headers } = context;
  const url = `https://api.cloudflare.com/client/v4/accounts/${context.accountId}/hyperdrive/configs/${target.id}`;
  try {
    const read = await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (read.status === 401 || read.status === 403) {
      return { name: target.name, state: 'permission-required' };
    }
    if (!read.ok) { return { name: target.name, state: 'unavailable' }; }
    const body = await read.json() as { success?: boolean; result?: Configuration };
    if (!body.success || !body.result) { return { name: target.name, state: 'unavailable' }; }
    let patch: ReturnType<typeof hyperdrivePatchV1>;
    try { patch = hyperdrivePatchV1(target.name, body.result); }
    catch { return { name: target.name, state: 'unexpected-origin' }; }
    const compliant = body.result.caching?.disabled === true && body.result.origin_connection_limit === patch.origin_connection_limit;
    if (compliant || !context.apply) {
      return { name: target.name, state: compliant ? 'verified' : 'unavailable',
        cacheDisabled: body.result.caching?.disabled === true, originConnections: body.result.origin_connection_limit };
    }
    return await applyHyperdrivePatchV1(target.name, url, patch, { fetcher, headers });
  } catch {
    // Never print provider JSON, errors, origin addresses or token-bearing Request objects.
    return { name: target.name, state: 'unavailable' };
  }
}

/** The narrow patch, then a separate read; an accepted PATCH is never treated as verified state. */
async function applyHyperdrivePatchV1(
  name: Name,
  url: string,
  patch: ReturnType<typeof hyperdrivePatchV1>,
  { fetcher, headers }: HyperdriveRequestV1,
): Promise<HyperdriveCheckV1> {
  const write = await fetcher(url, { method: 'PATCH', headers, body: JSON.stringify(patch),
    redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (write.status === 401 || write.status === 403) {
    return { name: name, state: 'permission-required' };
  }
  if (!write.ok) { return { name: name, state: 'unavailable' }; }
  // Confirm with a separate read; never treat an accepted PATCH as verified state.
  const check = await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!check.ok) { return { name: name, state: 'unavailable' }; }
  const verified = await check.json() as { success?: boolean; result?: Configuration };
  const actual = verified.result;
  const matches = verified.success && actual?.caching?.disabled === true
    && actual.origin_connection_limit === patch.origin_connection_limit;
  return { name: name, state: matches ? 'updated' : 'unavailable',
    cacheDisabled: actual?.caching?.disabled === true, originConnections: actual?.origin_connection_limit };
}

export async function configureProductionHyperdriveV1(input: {
  accountId: string; token: string; apply: boolean; fetcher?: typeof fetch;
}): Promise<HyperdriveCheckV1[]> {
  if (!/^[a-f0-9]{32}$/u.test(input.accountId) || !input.token) throw new Error('Cloudflare configuration credentials missing');
  const fetcher = input.fetcher ?? fetch;
  const headers = { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' };
  const results: HyperdriveCheckV1[] = [];
  for (const target of configurations) {
    results.push(await checkHyperdriveV1(target, { accountId: input.accountId, apply: input.apply, fetcher, headers }));
  }
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await configureProductionHyperdriveV1({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
    token: process.env.CLOUDFLARE_API_TOKEN ?? '', apply: process.argv.includes('--apply') });
  console.log(JSON.stringify({ event: 'production-hyperdrive-check-v1', checks: result }));
  if (result.some((item) => !['verified', 'updated'].includes(item.state)))
    console.log('::warning::Hyperdrive verification remains incomplete; check the sanitized status. No permission was bypassed.');
}

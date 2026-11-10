import type { PortalClassCatalogV2, ClassCatalogPageV2 } from './accounts-client-v2';
import { PortalClientErrorV1 } from '../../student-portal/shared/transport-v1';

/** Complete, bounded catalog. Repeated cursors and silent truncation are rejected. */
export async function readClassOptionsV1(catalog: PortalClassCatalogV2, signal: AbortSignal) {
  const items: ClassCatalogPageV2['items'] = [],
    seen = new Set<number>();
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    signal.throwIfAborted();
    const result = await catalog(offset, '', signal);
    for (const item of result.items) {
      if (seen.has(item.id)) throw new PortalClientErrorV1('invalid-response');
      seen.add(item.id);
      items.push(item);
    }
    if (result.nextOffset === null) return items;
    if (result.nextOffset <= offset || !Number.isSafeInteger(result.nextOffset))
      throw new PortalClientErrorV1('invalid-response');
    offset = result.nextOffset;
  }
  throw new PortalClientErrorV1('unavailable');
}

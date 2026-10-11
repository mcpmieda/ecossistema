import { createHash } from 'node:crypto';
import { z } from 'zod';
import { STUDENT_NAME_MAX_LENGTH_V1 } from '../../../shared/student-identity/student-identity-v1';
import { seal, unseal } from '../../auth/sealed';
import { pageCursorV1 } from '../../../shared/student-portal-contracts/core-v1';
import type { AdminQueryV1 } from '../../../shared/student-portal-contracts/admin-v1';
import type { AdminReadQueryV2 } from '../../../shared/student-portal-contracts/admin-read-v2';

type Query = AdminQueryV1 | AdminReadQueryV2;
const scopedInventory = (query: Query) => ['settings-overrides', 'customizations-read'].includes(query.operation);
const settingsKeyV1 = z.string().regex(/^(?:class:2026:[1-9]\d*|shift:2026:(?:MATUTINO|VESPERTINO|NOTURNO)|account:2026:[0-9a-f-]{36})$/u);
const cursorV1 = z.object({
  v: z.literal(1), a: z.uuid(), q: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), e: z.number().int().positive(),
  k: z.union([z.uuid(), settingsKeyV1]), t: z.iso.datetime().optional(),
  n: z.string().max(STUDENT_NAME_MAX_LENGTH_V1).optional(),
}).strict();
export class AdminCursorV1 {
  private readonly secret: string;
  constructor(secret: string) {
    if (secret.length < 43) throw new Error('student-portal-cursor-key-unavailable');
    this.secret = `student-portal-admin-cursor-v1:${secret}`;
  }
  private queryDigest(query: Query): string {
    return createHash('sha256').update(JSON.stringify({ ...query, page: { limit: query.page.limit } })).digest('base64url');
  }
  async read(query: Query, actor: string, now: Date): Promise<{ id: string; at?: string; name?: string } | null> {
    if (!query.page.cursor) return null;
    const token = pageCursorV1.safeParse(query.page.cursor);
    if (!token.success) throw new Error('student-portal-cursor-invalid-request');
    const parsed = cursorV1.safeParse(await unseal(token.data, this.secret));
    if (!parsed.success || parsed.data.a !== actor || parsed.data.q !== this.queryDigest(query) ||
      parsed.data.e <= now.getTime() || parsed.data.e > now.getTime() + 300_000)
      throw new Error('student-portal-cursor-invalid-request');
    (scopedInventory(query) ? settingsKeyV1 : z.uuid()).parse(parsed.data.k);
    return { id: parsed.data.k, ...(parsed.data.t ? { at: parsed.data.t } : {}),
      ...(parsed.data.n !== undefined ? { name: parsed.data.n } : {}) };
  }
  async next(query: Query, actor: string, now: Date, id: string, at?: string, name?: string): Promise<string> {
    (scopedInventory(query) ? settingsKeyV1 : z.uuid()).parse(id);
    return pageCursorV1.parse(await seal(cursorV1.parse({
      v: 1, a: actor, q: this.queryDigest(query), e: now.getTime() + 300_000, k: id,
      ...(at ? { t: at } : {}), ...(name !== undefined ? { n: name } : {}),
    }), this.secret));
  }
}

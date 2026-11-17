// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = (name: string) =>
  readFile(new URL('../../migrations/collector/' + name, import.meta.url), 'utf8');
const DROP = '0018_drop_delegated_sign_in_columns_v1.sql';
const grant = '11111111-1111-4111-8111-111111111111';

async function database() {
  const db = new PGlite();
  for (const name of [
    '0001_device_authorization.sql',
    '0002_pending_pairings.sql',
    '0015_session_authorization_v1.sql',
  ])
    await db.exec(await migration(name));
  return db;
}
async function columns(db: PGlite) {
  const found = await db.query<{ name: string }>(
    `SELECT table_name || '.' || column_name AS name FROM information_schema.columns
     WHERE table_schema='collector_auth'
       AND (column_name='encrypted_refresh' OR column_name LIKE 'oauth\\_%') ORDER BY 1`,
  );
  return found.rows.map((row) => row.name);
}
const pairing = (state: string) =>
  `INSERT INTO collector_auth.pairings(id,public_key,key_thumbprint,poll_hash,display_code,created_at,expires_at,state)
   SELECT gen_random_uuid(),
     jsonb_build_object('kty','EC','crv','P-256','x',repeat('x',43),'y',repeat('y',43),'ext',true),
     repeat('t',43),repeat('a',64),'123456',t,t+interval '10 minutes','${state}'
   FROM (SELECT clock_timestamp() AS t) stamp`;

describe('the delegated sign-in columns leave the collector tables', () => {
  it('drops the four columns and keeps every row', async () => {
    const db = await database();
    await db.exec(
      `INSERT INTO collector_auth.oauth_grants(id,tenant_id,actor_id,client_id,generation,credential_version,origin_authenticated_at,state)
       VALUES('${grant}',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),1,0,clock_timestamp(),'active');
       ${pairing('pending')};`,
    );
    expect(await columns(db)).toEqual([
      'oauth_grants.encrypted_refresh',
      'pairings.oauth_consumed_at',
      'pairings.oauth_nonce_hash',
      'pairings.oauth_state_hash',
    ]);
    await db.exec(await migration(DROP));
    expect(await columns(db)).toEqual([]);
    const kept = await db.query<{ grants: number; pairings: number }>(
      `SELECT (SELECT count(*)::int FROM collector_auth.oauth_grants) AS grants,
              (SELECT count(*)::int FROM collector_auth.pairings) AS pairings`,
    );
    expect(kept.rows[0]).toEqual({ grants: 1, pairings: 1 });
    await db.close();
  }, 60_000);
  it.each([
    [
      'a grant still holds a refresh token',
      `INSERT INTO collector_auth.oauth_grants(id,tenant_id,actor_id,client_id,generation,credential_version,origin_authenticated_at,encrypted_refresh,state)
       VALUES('${grant}',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),1,0,clock_timestamp(),repeat('synthetic',5),'needs_reauth')`,
    ],
    ['a pairing is still inside the delegated sign-in', pairing('exchanging')],
  ])(
    'refuses while %s, and changes nothing',
    async (reason, row) => {
      const db = await database();
      await db.exec(row);
      await expect(db.exec(await migration(DROP))).rejects.toThrow(reason);
      await db.exec('ROLLBACK');
      expect(await columns(db)).toHaveLength(4);
      await db.close();
    },
    60_000,
  );
});

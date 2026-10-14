export interface CollectorSqlV1 {
  query<T extends Record<string, unknown>>(statement: string, parameters: unknown[]): Promise<T[]>;
}
export type CollectorConsumptionV1 = {
  deviceId: string; generation: number; tenantId: string; actorId: string; clientId: string;
  keyThumbprint: string; nonceHash: string; maximumExpiry: number;
};

/** SQL is fixed and parameterized. Credentials/connections remain server-owned.
 * Device/grant rows are locked only for the final state change, never for Graph I/O. */
export class CollectorAuthorizationStoreV1 {
  constructor(private readonly sql: CollectorSqlV1) {}

  async snapshot(deviceId: string, forRevoke=false): Promise<Record<string, unknown> | null> {
    const rows = await this.sql.query(`SELECT d.id AS device_id, d.generation AS device_generation,
      d.tenant_id,d.actor_id,d.public_key,d.key_thumbprint,d.revoked_at AS device_revoked_at,
      g.id AS grant_id,g.client_id,g.generation AS grant_generation,g.credential_version,
      g.origin_authenticated_at,g.encrypted_refresh,g.state,g.revoked_at AS grant_revoked_at,
      g.directory_authorized,g.directory_checked_at,g.directory_valid_until
      FROM collector_auth.devices d JOIN collector_auth.oauth_grants g ON g.id=d.grant_id
      WHERE d.id=$1 AND d.tenant_id=g.tenant_id AND d.actor_id=g.actor_id
        AND ($2::boolean OR EXISTS(SELECT 1 FROM collector_auth.pairings p WHERE p.device_id=d.id AND p.state='completed' AND p.claimed_at IS NOT NULL))`, [deviceId,forRevoke]);
    return rows.length === 1 ? rows[0]! : null;
  }

  async saveChallenge(input: { nonceHash: string; deviceId: string; generation: number;
    keyThumbprint: string; issuedAt: number; expiresAt: number }): Promise<void> {
    await this.sql.query(`INSERT INTO collector_auth.challenges(nonce_hash,device_id,generation,key_thumbprint,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [input.nonceHash,input.deviceId,input.generation,input.keyThumbprint,
      new Date(input.issuedAt).toISOString(),new Date(input.expiresAt).toISOString()]);
  }

  async challenge(deviceId: string, nonceHash: string): Promise<Record<string, unknown> | null> {
    const rows = await this.sql.query(`SELECT generation,key_thumbprint,issued_at,expires_at FROM collector_auth.challenges
      WHERE device_id=$1 AND nonce_hash=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp()`, [deviceId,nonceHash]);
    return rows.length === 1 ? rows[0]! : null;
  }

  async consumeAndAuthorize(input: CollectorConsumptionV1): Promise<number | null> {
    const rows = await this.sql.query<{ expires_at: Date | string }>(`
      WITH active AS MATERIALIZED (
        SELECT d.id, g.directory_valid_until
        FROM collector_auth.devices d JOIN collector_auth.oauth_grants g ON g.id = d.grant_id
        WHERE d.id = $1 AND d.generation = $2 AND d.tenant_id = $3 AND d.actor_id = $4
          AND d.key_thumbprint = $5 AND d.revoked_at IS NULL
          AND g.tenant_id = d.tenant_id AND g.actor_id = d.actor_id
          AND g.client_id = $7
          AND g.state = 'active' AND g.revoked_at IS NULL AND g.directory_authorized
          AND g.directory_checked_at <= clock_timestamp()
          AND g.directory_valid_until = g.directory_checked_at + interval '5 minutes'
          AND g.directory_valid_until > clock_timestamp()
          AND EXISTS(SELECT 1 FROM collector_auth.pairings p WHERE p.device_id=d.id AND p.state='completed' AND p.claimed_at IS NOT NULL)
        FOR UPDATE OF d, g
      ), consumed AS (
        UPDATE collector_auth.challenges c SET consumed_at = clock_timestamp()
        FROM active a WHERE c.device_id = a.id AND c.nonce_hash = $6
          AND c.generation = $2 AND c.key_thumbprint = $5
          AND c.consumed_at IS NULL AND c.issued_at <= clock_timestamp()
          AND c.expires_at > clock_timestamp()
          AND $8::timestamptz > clock_timestamp()
        RETURNING a.directory_valid_until
      )
      SELECT LEAST(directory_valid_until, $8::timestamptz, clock_timestamp() + interval '5 minutes') AS expires_at FROM consumed
    `, [input.deviceId, input.generation, input.tenantId, input.actorId, input.keyThumbprint, input.nonceHash, input.clientId,
      new Date(input.maximumExpiry).toISOString()]);
    if (rows.length !== 1) return null;
    const value = rows[0]!.expires_at;
    return value instanceof Date ? value.getTime() : Date.parse(value);
  }

  async revokeDevice(deviceId: string, tenantId: string, actorId: string,keyThumbprint:string|null=null): Promise<void> {
    await this.sql.query(`WITH owned AS MATERIALIZED (
      SELECT d.id,d.grant_id FROM collector_auth.devices d JOIN collector_auth.oauth_grants g ON g.id=d.grant_id
      WHERE d.id=$1 AND d.tenant_id=$2 AND d.actor_id=$3 AND ($4::text IS NULL OR d.key_thumbprint=$4)
        AND g.tenant_id=d.tenant_id AND g.actor_id=d.actor_id FOR UPDATE OF d,g
      ), revoked AS (
      UPDATE collector_auth.devices d SET revoked_at=COALESCE(d.revoked_at,clock_timestamp()),
        generation=generation+CASE WHEN d.revoked_at IS NULL THEN 1 ELSE 0 END FROM owned o WHERE d.id=o.id RETURNING d.id,d.grant_id
      ) UPDATE collector_auth.oauth_grants g SET state='revoked',revoked_at=COALESCE(g.revoked_at,clock_timestamp()),generation=generation+1,
        encrypted_refresh=NULL,directory_authorized=false,directory_checked_at=NULL,directory_valid_until=NULL,refresh_owner=NULL,refresh_until=NULL
      FROM revoked r WHERE g.id=r.grant_id AND NOT EXISTS(SELECT 1 FROM collector_auth.devices other
        WHERE other.grant_id=g.id AND other.id<>r.id AND other.revoked_at IS NULL)`, [deviceId, tenantId, actorId,keyThumbprint]);
  }

  async ownedDevice(deviceId:string,tenantId:string,actorId:string):Promise<boolean>{
    return await this.ownedKey(deviceId,tenantId,actorId)!==null;
  }

  async ownedKey(deviceId:string,tenantId:string,actorId:string):Promise<string|null>{
    const rows=await this.sql.query<{key_thumbprint:string}>(`SELECT d.key_thumbprint FROM collector_auth.devices d
      JOIN collector_auth.oauth_grants g ON g.id=d.grant_id WHERE d.id=$1 AND d.tenant_id=$2 AND d.actor_id=$3
      AND g.tenant_id=d.tenant_id AND g.actor_id=d.actor_id`,[deviceId,tenantId,actorId]);
    return rows.length===1?rows[0]!.key_thumbprint:null;
  }

  async revocationStatus(deviceId:string,keyThumbprint:string):Promise<boolean>{
    const result=await this.sql.query<{revoked:boolean}>(`SELECT NOT EXISTS(SELECT 1 FROM collector_auth.devices
      WHERE id=$1 AND key_thumbprint=$2 AND revoked_at IS NULL) AS revoked`,[deviceId,keyThumbprint]);
    return result[0]?.revoked===true;
  }

  async consumeAndRevoke(input:Omit<CollectorConsumptionV1,'maximumExpiry'>):Promise<boolean>{
    const rows=await this.sql.query(`WITH active AS MATERIALIZED (
      SELECT d.id,d.grant_id FROM collector_auth.devices d JOIN collector_auth.oauth_grants g ON g.id=d.grant_id
      WHERE d.id=$1 AND d.generation=$2 AND d.tenant_id=$3 AND d.actor_id=$4 AND d.key_thumbprint=$5
        AND g.tenant_id=d.tenant_id AND g.actor_id=d.actor_id AND g.client_id=$7 FOR UPDATE OF d,g
      ), consumed AS (
      UPDATE collector_auth.challenges c SET consumed_at=clock_timestamp() FROM active a
      WHERE c.device_id=a.id AND c.nonce_hash=$6 AND c.generation=$2 AND c.key_thumbprint=$5
        AND c.consumed_at IS NULL AND c.issued_at<=clock_timestamp() AND c.expires_at>clock_timestamp() RETURNING a.id,a.grant_id
      ), revoked AS (
      UPDATE collector_auth.devices d SET revoked_at=COALESCE(d.revoked_at,clock_timestamp()),
        generation=generation+CASE WHEN d.revoked_at IS NULL THEN 1 ELSE 0 END FROM consumed c
      WHERE d.id=c.id RETURNING d.id,d.grant_id
      ), retired AS (
      UPDATE collector_auth.oauth_grants g SET state='revoked',revoked_at=clock_timestamp(),generation=generation+1,
        encrypted_refresh=NULL,directory_authorized=false,directory_checked_at=NULL,directory_valid_until=NULL,
        refresh_owner=NULL,refresh_until=NULL FROM revoked r
      WHERE g.id=r.grant_id AND NOT EXISTS(SELECT 1 FROM collector_auth.devices other WHERE other.grant_id=g.id
        AND other.id<>r.id AND other.revoked_at IS NULL) RETURNING g.id
      ) SELECT id FROM revoked`,[input.deviceId,input.generation,input.tenantId,input.actorId,input.keyThumbprint,input.nonceHash,input.clientId]);
    return rows.length===1;
  }

  async claimRefresh(grantId: string, generation: number, version: number, owner: string): Promise<boolean> {
    const rows = await this.sql.query(`UPDATE collector_auth.oauth_grants
      SET refresh_owner = $4, refresh_until = clock_timestamp() + interval '20 seconds'
      WHERE id = $1 AND generation = $2 AND credential_version = $3 AND state = 'active' AND revoked_at IS NULL
        AND (refresh_until IS NULL OR refresh_until <= clock_timestamp()) RETURNING id`, [grantId, generation, version, owner]);
    return rows.length === 1;
  }

  async commitRefresh(input: { grantId: string; generation: number; version: number; owner: string;
    encryptedReplacement: string; directoryCheckedAt: number }): Promise<boolean> {
    const rows = await this.sql.query(`UPDATE collector_auth.oauth_grants
      SET encrypted_refresh = $5, credential_version = credential_version + 1,
        directory_authorized = true, directory_checked_at = $6,
        directory_valid_until = $6::timestamptz + interval '5 minutes', refresh_owner = NULL, refresh_until = NULL
      WHERE id = $1 AND generation = $2 AND credential_version = $3 AND state = 'active' AND revoked_at IS NULL
        AND refresh_owner = $4 AND refresh_until > clock_timestamp()
        AND $6::timestamptz <= clock_timestamp() AND $6::timestamptz + interval '5 minutes' > clock_timestamp()
      RETURNING id`, [input.grantId, input.generation, input.version, input.owner, input.encryptedReplacement,
      new Date(input.directoryCheckedAt).toISOString()]);
    return rows.length === 1;
  }

  async suspendGrant(grantId: string, generation: number, owner: string): Promise<void> {
    await this.sql.query(`UPDATE collector_auth.oauth_grants SET state = 'needs_reauth',
      encrypted_refresh = NULL, directory_authorized = false, directory_checked_at = NULL,
      directory_valid_until = NULL, refresh_owner = NULL, refresh_until = NULL, generation = generation + 1
      WHERE id = $1 AND generation = $2 AND refresh_owner = $3`, [grantId, generation, owner]);
  }

  async releaseRefresh(grantId: string, generation: number, version: number, owner: string): Promise<void> {
    await this.sql.query(`UPDATE collector_auth.oauth_grants SET refresh_owner=NULL,refresh_until=NULL
      WHERE id=$1 AND generation=$2 AND credential_version=$3 AND refresh_owner=$4`, [grantId,generation,version,owner]);
  }
}

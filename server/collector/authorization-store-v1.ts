export interface CollectorSqlV1 {
  query<T extends Record<string, unknown>>(statement: string, parameters: unknown[]): Promise<T[]>;
}
export type CollectorConsumptionV1 = {
  deviceId: string; generation: number; tenantId: string; actorId: string; clientId: string;
  keyThumbprint: string; nonceHash: string;
};

/** SQL is fixed and parameterized. Credentials/connections remain server-owned.
 * Device/grant rows are locked only for the final state change, never for Graph I/O. */
export class CollectorAuthorizationStoreV1 {
  constructor(private readonly sql: CollectorSqlV1) {}

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
        FOR UPDATE OF d, g
      ), consumed AS (
        UPDATE collector_auth.challenges c SET consumed_at = clock_timestamp()
        FROM active a WHERE c.device_id = a.id AND c.nonce_hash = $6
          AND c.generation = $2 AND c.key_thumbprint = $5
          AND c.consumed_at IS NULL AND c.issued_at <= clock_timestamp()
          AND c.expires_at > clock_timestamp()
        RETURNING a.directory_valid_until
      )
      SELECT LEAST(directory_valid_until, clock_timestamp() + interval '5 minutes') AS expires_at FROM consumed
    `, [input.deviceId, input.generation, input.tenantId, input.actorId, input.keyThumbprint, input.nonceHash, input.clientId]);
    if (rows.length !== 1) return null;
    const value = rows[0]!.expires_at;
    return value instanceof Date ? value.getTime() : Date.parse(value);
  }

  async revokeDevice(deviceId: string, tenantId: string, actorId: string): Promise<void> {
    await this.sql.query(`UPDATE collector_auth.devices SET revoked_at = clock_timestamp(), generation = generation + 1
      WHERE id = $1 AND tenant_id = $2 AND actor_id = $3 AND revoked_at IS NULL`, [deviceId, tenantId, actorId]);
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
}

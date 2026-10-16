import {z} from 'zod';
import type {CollectorSqlV1} from './authorization-store-v1';
import type {CollectorOAuthTransactionV1,CollectorRegistrationV1} from './oauth-v1';
import {collectorKeyThumbprintV1,collectorPublicKeyV1,type CollectorPublicKeyV1} from './device-proof-v1';

export async function collectorOpaqueHashV1(value:string):Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))))
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
const uuid=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/u);

/** Owner-only SQL adapter. Browser and native metadata are separate from any
 * Microsoft credential. Completion creates a new grant, never upserts an old
 * authentication origin, and copies only the originally confirmed public key. */
export class CollectorPairingStoreV1 {
  constructor(private readonly sql:CollectorSqlV1){}

  async create(input:{id:string;publicKey:CollectorPublicKeyV1;pollHash:string;displayCode:string;createdAt:number}):Promise<void>{
    const publicKey=collectorPublicKeyV1.parse(input.publicKey),fingerprint=await collectorKeyThumbprintV1(publicKey);
    await this.sql.query(`INSERT INTO collector_auth.pairings(id,public_key,key_thumbprint,poll_hash,display_code,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$6::timestamptz+interval '10 minutes')`,[uuid.parse(input.id),JSON.stringify(publicKey),fingerprint,
      hash.parse(input.pollHash),z.string().regex(/^\d{6}$/u).parse(input.displayCode),new Date(input.createdAt).toISOString()]);
  }

  /** One statement, one PostgreSQL transaction: quota checks, reservations
   * and pending INSERT are guarded by the same database advisory xact lock.
   * Rejected or failed inserts never consume any budget or pairing slot. */
  async createAdmitted(clientScope:string,input:{id:string;publicKey:CollectorPublicKeyV1;pollHash:string;displayCode:string;createdAt:number}):Promise<boolean>{
    if(!/^client:[a-f0-9]{64}$/u.test(clientScope))return false;
    const publicKey=collectorPublicKeyV1.parse(input.publicKey),fingerprint=await collectorKeyThumbprintV1(publicKey);
    const [result]=await this.sql.query<{allowed:boolean}>(`SELECT collector_auth.create_pairing_limited_v2(
      $1::text,$2::uuid,$3::jsonb,$4::text,$5::text,$6::text,$7::timestamptz) AS allowed`,[
      clientScope,uuid.parse(input.id),JSON.stringify(publicKey),fingerprint,hash.parse(input.pollHash),
      z.string().regex(/^\d{6}$/u).parse(input.displayCode),new Date(input.createdAt).toISOString()]);
    return result?.allowed===true;
  }

  async browserView(id:string):Promise<Record<string,unknown>|null>{
    const rows=await this.sql.query(`SELECT id,key_thumbprint,display_code,state,expires_at
      FROM collector_auth.pairings WHERE id=$1 AND expires_at>clock_timestamp() AND state='pending'`,[uuid.parse(id)]);
    return rows.length===1?rows[0]!:null;
  }

  async confirm(transaction:CollectorOAuthTransactionV1):Promise<boolean>{
    const rows=await this.sql.query(`UPDATE collector_auth.pairings SET state='confirmed',oauth_state_hash=$2,oauth_nonce_hash=$3
      WHERE id=$1 AND state='pending' AND expires_at>clock_timestamp()
        AND $4::timestamptz>clock_timestamp() AND $4::timestamptz<=expires_at RETURNING id`,
      [uuid.parse(transaction.pairingId),await collectorOpaqueHashV1(transaction.state),await collectorOpaqueHashV1(transaction.nonce),
        new Date(transaction.exp*1000).toISOString()]);
    return rows.length===1;
  }

  async consumeConfirmedTransaction(transaction:CollectorOAuthTransactionV1):Promise<boolean>{
    const rows=await this.sql.query(`UPDATE collector_auth.pairings SET state='exchanging',oauth_consumed_at=clock_timestamp()
      WHERE id=$1 AND state='confirmed' AND oauth_state_hash=$2 AND oauth_nonce_hash=$3
        AND oauth_consumed_at IS NULL AND expires_at>clock_timestamp() AND $4::timestamptz>clock_timestamp()
      RETURNING id`,[uuid.parse(transaction.pairingId),await collectorOpaqueHashV1(transaction.state),
      await collectorOpaqueHashV1(transaction.nonce),new Date(transaction.exp*1000).toISOString()]);
    return rows.length===1;
  }

  async registerConfirmedPairing(input:CollectorRegistrationV1):Promise<boolean>{
    const b=input.binding,d=input.directory;
    if(d.tenantId!==b.tenantId || d.actorId!==b.actorId || d.grantId!==b.grantId || d.grantGeneration!==b.generation
      || d.originAuthenticatedAt!==b.originAuthenticatedAt || d.directoryValidUntil-d.directoryCheckedAt!==300_000
      || b.generation!==1 || b.version!==0) return false;
    const deviceId=crypto.randomUUID();
    const rows=await this.sql.query(`WITH pending AS MATERIALIZED (
      SELECT id,public_key,key_thumbprint FROM collector_auth.pairings
      WHERE id=$1 AND state='exchanging' AND oauth_consumed_at IS NOT NULL AND device_id IS NULL
        AND expires_at>clock_timestamp() AND $8::timestamptz<=clock_timestamp()
        AND $8::timestamptz+interval '5 minutes'>clock_timestamp() FOR UPDATE
      ), granted AS (
      INSERT INTO collector_auth.oauth_grants(id,tenant_id,actor_id,client_id,generation,credential_version,
        origin_authenticated_at,encrypted_refresh,state,directory_authorized,directory_checked_at,directory_valid_until)
      SELECT $2,$3,$4,$5,1,0,$6,$7,'active',true,$8,$8::timestamptz+interval '5 minutes' FROM pending RETURNING id
      ), registered AS (
      INSERT INTO collector_auth.devices(id,grant_id,tenant_id,actor_id,public_key,key_thumbprint,generation,created_at)
      SELECT $9,g.id,$3,$4,p.public_key,p.key_thumbprint,1,clock_timestamp() FROM pending p CROSS JOIN granted g RETURNING id
      ) UPDATE collector_auth.pairings p SET state='completed',device_id=r.id FROM registered r
        WHERE p.id=$1 RETURNING p.id`,[uuid.parse(input.pairingId),uuid.parse(b.grantId),uuid.parse(b.tenantId),uuid.parse(b.actorId),
      uuid.parse(b.clientId),new Date(b.originAuthenticatedAt).toISOString(),input.encryptedRefresh,
      new Date(d.directoryCheckedAt).toISOString(),deviceId]);
    return rows.length===1;
  }

  async poll(id:string,pollHash:string):Promise<{state:string;device_id:string|null}|null>{
    const rows=await this.sql.query<{state:string;device_id:string|null}>(`SELECT state,device_id FROM collector_auth.pairings
      WHERE id=$1 AND poll_hash=$2 AND expires_at>clock_timestamp()`,[uuid.parse(id),hash.parse(pollHash)]);
    return rows.length===1?rows[0]!:null;
  }

  async cancel(id:string,pollHash:string):Promise<void>{
    await this.sql.query(`WITH owned AS MATERIALIZED (
      SELECT id,device_id FROM collector_auth.pairings WHERE id=$1 AND poll_hash=$2 AND expires_at>clock_timestamp() FOR UPDATE
      ), revoked AS (
      UPDATE collector_auth.devices d SET revoked_at=clock_timestamp(),generation=generation+1 FROM owned p
      WHERE d.id=p.device_id AND d.revoked_at IS NULL RETURNING d.id,d.grant_id
      ), retired AS (
      UPDATE collector_auth.oauth_grants g SET state='revoked',revoked_at=clock_timestamp(),generation=generation+1,
        encrypted_refresh=NULL,directory_authorized=false,directory_checked_at=NULL,directory_valid_until=NULL,
        refresh_owner=NULL,refresh_until=NULL FROM revoked r WHERE g.id=r.grant_id
        AND NOT EXISTS(SELECT 1 FROM collector_auth.devices other WHERE other.grant_id=g.id AND other.id<>r.id AND other.revoked_at IS NULL)
      RETURNING g.id
      ) UPDATE collector_auth.pairings p SET state='cancelled',oauth_state_hash=NULL,oauth_nonce_hash=NULL,device_id=NULL,claimed_at=NULL
      FROM owned o WHERE p.id=o.id`,[uuid.parse(id),hash.parse(pollHash)]);
  }

  async claim(id:string,pollHash:string):Promise<boolean>{
    const rows=await this.sql.query(`UPDATE collector_auth.pairings p SET claimed_at=clock_timestamp()
      WHERE p.id=$1 AND p.poll_hash=$2 AND p.state='completed' AND p.expires_at>clock_timestamp()
        AND EXISTS(SELECT 1 FROM collector_auth.devices d WHERE d.id=p.device_id AND d.revoked_at IS NULL)
      RETURNING p.id`,[uuid.parse(id),hash.parse(pollHash)]);
    return rows.length===1;
  }

  async retireExpiredUnclaimed():Promise<void>{
    await this.sql.query(`WITH expired AS MATERIALIZED (
      SELECT id,device_id FROM collector_auth.pairings WHERE expires_at<=clock_timestamp()
        AND claimed_at IS NULL AND state IN ('pending','confirmed','exchanging','completed') LIMIT 50 FOR UPDATE SKIP LOCKED
      ), revoked AS (
      UPDATE collector_auth.devices d SET revoked_at=clock_timestamp(),generation=generation+1 FROM expired p
      WHERE d.id=p.device_id AND d.revoked_at IS NULL RETURNING d.id,d.grant_id
      ), retired AS (
      UPDATE collector_auth.oauth_grants g SET state='revoked',revoked_at=clock_timestamp(),generation=generation+1,
        encrypted_refresh=NULL,directory_authorized=false,directory_checked_at=NULL,directory_valid_until=NULL,
        refresh_owner=NULL,refresh_until=NULL FROM revoked r WHERE g.id=r.grant_id
        AND NOT EXISTS(SELECT 1 FROM collector_auth.devices other WHERE other.grant_id=g.id AND other.id<>r.id AND other.revoked_at IS NULL)
      RETURNING g.id
      ) UPDATE collector_auth.pairings p SET state='cancelled',oauth_state_hash=NULL,oauth_nonce_hash=NULL,device_id=NULL,claimed_at=NULL
        FROM expired e WHERE p.id=e.id`,[]);
  }

  /** Bounded retention (migration collector/0005). Only finished rows go: expired
   * challenges (anti-replay needs them only until expiry) and cancelled pairings
   * without a device. Completed pairings stay: authorization requires them.
   * Skipped until the DELETE grant exists, so deploy order cannot break access. */
  async purgeFinished():Promise<void>{
    const [grant]=await this.sql.query<{ready:boolean}>(`SELECT has_table_privilege(current_user,'collector_auth.challenges','DELETE')
      AND has_table_privilege(current_user,'collector_auth.pairings','DELETE') AS ready`,[]);
    if(grant?.ready!==true)return;
    // Only the collector runtime sees these pseudonymous rate-limit scopes.
    await this.sql.query(`DELETE FROM collector_auth.pairing_rate_v1 WHERE ctid IN (
      SELECT ctid FROM collector_auth.pairing_rate_v1 WHERE scope<>'global'
      AND window_started_at<clock_timestamp()-interval '2 days' LIMIT 500)`,[]).catch(()=>undefined);
    await this.sql.query(`WITH challenges AS (DELETE FROM collector_auth.challenges WHERE ctid IN (SELECT ctid FROM collector_auth.challenges
      WHERE expires_at<clock_timestamp()-interval '1 hour' LIMIT 500) RETURNING 1
      ), pairings AS (DELETE FROM collector_auth.pairings WHERE ctid IN (SELECT ctid FROM collector_auth.pairings
      WHERE state='cancelled' AND device_id IS NULL AND expires_at<clock_timestamp()-interval '1 day' LIMIT 500) RETURNING 1
      ) SELECT (SELECT count(*) FROM challenges)+(SELECT count(*) FROM pairings) AS removed`,[]);
  }
}

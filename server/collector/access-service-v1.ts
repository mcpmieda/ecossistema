import { z } from 'zod';
import { CollectorAuthorizationStoreV1 } from './authorization-store-v1';
import { CollectorRefreshCipherV1, type CollectorGrantBindingV1 } from './refresh-cipher-v1';
import { collectorLeaseExpiryV1, CollectorDirectoryErrorV1, readCollectorOwnDirectoryV1,
  type CollectorDirectoryDependenciesV1, type CollectorDirectoryEvidenceV1 } from './directory-v1';
import { collectorAccountKeyV1, collectorPublicKeyV1, issueCollectorChallengeV1, verifyCollectorDeviceProofV1,
  type CollectorDeviceProofRecordV1, type CollectorChallengeV1 } from './device-proof-v1';

const date = z.union([z.date(),z.string().datetime({ offset:true })]).transform(value => value instanceof Date ? value.getTime() : Date.parse(value));
const snapshotSchema = z.object({ device_id:z.string().uuid(),device_generation:z.number().int().positive(),
  tenant_id:z.string().uuid(),actor_id:z.string().uuid(),public_key:collectorPublicKeyV1,key_thumbprint:z.string(),
  device_revoked_at:date.nullable(),grant_id:z.string().uuid(),client_id:z.string().uuid(),
  grant_generation:z.number().int().positive(),credential_version:z.number().int().nonnegative(),
  origin_authenticated_at:date,encrypted_refresh:z.string().nullable(),state:z.enum(['active','needs_reauth','revoked']),
  grant_revoked_at:date.nullable(),directory_authorized:z.boolean(),directory_checked_at:date.nullable(),directory_valid_until:date.nullable() });
type Snapshot = z.infer<typeof snapshotSchema>;
export class CollectorAccessErrorV1 extends Error {
  constructor(readonly reason: 'denied' | 'unavailable' | 'reauthentication-required') { super('collector-access-'+reason); }
}
const binding = (row:Snapshot):CollectorGrantBindingV1 => ({ tenantId:row.tenant_id,actorId:row.actor_id,clientId:row.client_id,
  grantId:row.grant_id,generation:row.grant_generation,version:row.credential_version,originAuthenticatedAt:row.origin_authenticated_at });
const record = (row:Snapshot):CollectorDeviceProofRecordV1 => ({ deviceId:row.device_id,generation:row.device_generation,
  tenantId:row.tenant_id,actorId:row.actor_id,publicKey:row.public_key,keyThumbprint:row.key_thumbprint,revokedAt:row.device_revoked_at });
const evidence = (row:Snapshot):CollectorDirectoryEvidenceV1 | null => row.directory_authorized
  && row.directory_checked_at !== null && row.directory_valid_until !== null
  ? { tenantId:row.tenant_id,actorId:row.actor_id,grantId:row.grant_id,grantGeneration:row.grant_generation,
    originAuthenticatedAt:row.origin_authenticated_at,directoryCheckedAt:row.directory_checked_at,directoryValidUntil:row.directory_valid_until } : null;
async function nonceHash(value:string):Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))))
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

/** Internal broker only. No handler may serialize snapshots, ciphertext or refresh results.
 * Public methods emit only a challenge or a collector-specific authorization receipt. */
export class CollectorAccessServiceV1 {
  constructor(private readonly store:CollectorAuthorizationStoreV1,private readonly cipher:CollectorRefreshCipherV1,
    private readonly config:{tenantId:string;clientId:string;adminGroupId:string},
    private readonly dependencies:CollectorDirectoryDependenciesV1) {}

  private async active(deviceId:string):Promise<Snapshot> {
    const value=snapshotSchema.safeParse(await this.store.snapshot(z.string().uuid().parse(deviceId)));
    if (!value.success) throw new CollectorAccessErrorV1('denied');
    const row=value.data;
    if (row.device_revoked_at !== null || row.grant_revoked_at !== null || row.state !== 'active'
      || row.tenant_id !== this.config.tenantId || row.client_id !== this.config.clientId)
      throw new CollectorAccessErrorV1('denied');
    return row;
  }

  async challenge(deviceId:string):Promise<CollectorChallengeV1> {
    const row=await this.active(deviceId);
    const challenge=await issueCollectorChallengeV1(record(row),this.dependencies.now());
    await this.store.saveChallenge({nonceHash:await nonceHash(challenge.nonce),deviceId:row.device_id,
      generation:challenge.generation,keyThumbprint:challenge.keyThumbprint,issuedAt:challenge.issuedAt,expiresAt:challenge.expiresAt});
    return challenge;
  }

  private async fresh(row:Snapshot):Promise<Snapshot> {
    const existing=evidence(row);
    if (existing) {
      try { collectorLeaseExpiryV1(binding(row),existing,this.dependencies.now()); return row; }
      catch { /* Expired directory evidence never gets extended by local revocation checks. */ }
    }
    const owner=crypto.randomUUID(), source=binding(row);
    if (!await this.store.claimRefresh(source.grantId,source.generation,source.version,owner))
      throw new CollectorAccessErrorV1('unavailable');
    try {
      if (row.encrypted_refresh === null) throw new CollectorAccessErrorV1('reauthentication-required');
      const refresh=await this.cipher.decrypt(row.encrypted_refresh,source);
      const result=await readCollectorOwnDirectoryV1({binding:source,expectedTenantId:this.config.tenantId,
        expectedClientId:this.config.clientId,adminGroupId:this.config.adminGroupId,refreshToken:refresh,dependencies:this.dependencies});
      const encryptedReplacement=await this.cipher.encrypt(result.nextRefreshToken,{...source,version:source.version+1});
      if (!await this.store.commitRefresh({grantId:source.grantId,generation:source.generation,version:source.version,
        owner,encryptedReplacement,directoryCheckedAt:result.evidence.directoryCheckedAt})) throw new CollectorAccessErrorV1('denied');
      return await this.active(row.device_id);
    } catch (error) {
      if (error instanceof CollectorDirectoryErrorV1 && error.reason !== 'unavailable') {
        await this.store.suspendGrant(source.grantId,source.generation,owner);
        throw new CollectorAccessErrorV1('reauthentication-required');
      }
      throw error instanceof CollectorAccessErrorV1 ? error : new CollectorAccessErrorV1('unavailable');
    } finally { await this.store.releaseRefresh(source.grantId,source.generation,source.version,owner); }
  }

  async authorize(input:{deviceId:string;nonce:string;signature:string}) {
    const row=await this.active(input.deviceId), hash=await nonceHash(z.string().regex(/^[A-Za-z0-9_-]{43}$/u).parse(input.nonce));
    const saved=z.object({generation:z.number().int().positive(),key_thumbprint:z.string(),issued_at:date,expires_at:date})
      .safeParse(await this.store.challenge(input.deviceId,hash));
    if (!saved.success) throw new CollectorAccessErrorV1('denied');
    const challenge:CollectorChallengeV1={deviceId:row.device_id,generation:saved.data.generation,
      accountKey:await collectorAccountKeyV1(row.tenant_id,row.actor_id),keyThumbprint:saved.data.key_thumbprint,
      nonce:input.nonce,audience:'https://admin.escolaieda.com',method:'POST',path:'/api/frequency-collector/access',
      purpose:'collector-access',issuedAt:saved.data.issued_at,expiresAt:saved.data.expires_at};
    try { await verifyCollectorDeviceProofV1({record:record(row),challenge,signature:input.signature,now:this.dependencies.now()}); }
    catch { throw new CollectorAccessErrorV1('denied'); }
    const current=await this.fresh(row), currentEvidence=evidence(current);
    if (!currentEvidence || current.device_generation !== row.device_generation || current.grant_id !== row.grant_id)
      throw new CollectorAccessErrorV1('denied');
    collectorLeaseExpiryV1(binding(current),currentEvidence,this.dependencies.now());
    const expires=await this.store.consumeAndAuthorize({deviceId:current.device_id,generation:current.device_generation,
      tenantId:current.tenant_id,actorId:current.actor_id,clientId:current.client_id,keyThumbprint:current.key_thumbprint,nonceHash:hash,
      maximumExpiry:currentEvidence.directoryValidUntil});
    if (expires === null) throw new CollectorAccessErrorV1('denied');
    return {contractVersion:2,authenticated:true,authorized:true,capability:'frequency.collector.use',
      identityKey:current.device_id+':'+await collectorAccountKeyV1(current.tenant_id,current.actor_id),
      expiresAt:new Date(expires).toISOString(),checkedAt:new Date(this.dependencies.now()).toISOString(),
      directoryCheckedAt:new Date(currentEvidence.directoryCheckedAt).toISOString(),
      directoryValidUntil:new Date(currentEvidence.directoryValidUntil).toISOString(),revocationChecked:true};
  }
}

import {
  photoWriteContextV1, photoWriteCommandV1, photoWritePlanV1, photoWriteReceiptV1, photoAssetsV1,
  assertPhotoWritePlanV1, assertPhotoUploadedAssetsV1, photoWriteFingerprintV1, photoAssetKeyV1, PhotoWriteErrorV1,
  type PhotoWriteContextV1, type PhotoWriteCommandV1, type PhotoWritePlanV1, type PhotoWriteReceiptV1,
  type PhotoAssetsV1, type PhotoAssetV1,
} from '../../shared/student-photos/write-v1';

export interface PhotoWriteQueryV1 {
  query(text: string, parameters?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
}
export interface PhotoWriteDatabaseV1 {
  transaction<T>(work: (tx: PhotoWriteQueryV1) => Promise<T>): Promise<T>;
}
interface PhotoPreparedPayloadV1 { portrait: Uint8Array | null; avatar: Uint8Array | null }
const emptyAssets = (): PhotoAssetsV1 => ({ portrait: null, avatar: null });
const hex = (bytes: Uint8Array | null) => bytes === null ? null : Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');

/** Context comes from sealed administrative authorization, never from request data.
 * Production composition enables durablePayload; protocol-only fixtures may omit it. */
export class PhotoWriteRepositoryV1 {
  constructor(private readonly database: PhotoWriteDatabaseV1, private readonly durablePayload = false) {}
  private async transaction<T>(work: (tx: PhotoWriteQueryV1) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(async tx => {
        await tx.query("SET LOCAL lock_timeout='3s'");
        await tx.query("SET LOCAL statement_timeout='10s'");
        return work(tx);
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw new PhotoWriteErrorV1('receipt-conflict');
      throw error;
    }
  }
  private async family(tx: PhotoWriteQueryV1, uid: string) {
    const rows = await tx.query(`SELECT revision::text,pending_request::text,assets
      FROM student_photos.photo_family_v1 WHERE student_uid=$1::uuid FOR UPDATE`, [uid]);
    const row = rows[0];
    if (!row) throw new PhotoWriteErrorV1('not-found');
    return { revision:photoWriteCommandV1.shape.expectedRevision.parse(row.revision),
      pending:photoWriteCommandV1.shape.expectedRevision.parse(row.pending_request),assets:photoAssetsV1.parse(row.assets) };
  }
  private async receipt(tx: PhotoWriteQueryV1, context: PhotoWriteContextV1, requestId: string) {
    const rows = await tx.query('SELECT receipt FROM student_photos.write_operation_v1 WHERE request_id=$1::uuid', [requestId]);
    if (!rows[0]) return null;
    const receipt = photoWriteReceiptV1.parse(rows[0].receipt);
    if (receipt.actorId !== context.actorId || receipt.studentUid !== context.studentUid) throw new PhotoWriteErrorV1('receipt-conflict');
    return receipt;
  }
  private async store(tx: PhotoWriteQueryV1, receipt: PhotoWriteReceiptV1): Promise<void> {
    const parsed = photoWriteReceiptV1.parse(receipt);
    await tx.query(`UPDATE student_photos.write_operation_v1 SET receipt=$2::text::jsonb,updated_at=statement_timestamp()
      WHERE request_id=$1::uuid`, [parsed.requestId,JSON.stringify(parsed)]);
  }
  private async audit(tx: PhotoWriteQueryV1, receipt: PhotoWriteReceiptV1, event: string, assetKey: string|null=null) {
    await tx.query(`INSERT INTO student_photos.write_audit_v1(request_id,student_uid,actor_id,event,asset_key)
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5)`, [receipt.requestId,receipt.studentUid,receipt.actorId,event,assetKey]);
  }
  private async stage(tx:PhotoWriteQueryV1,receipt:PhotoWriteReceiptV1,payload?:PhotoPreparedPayloadV1) {
    if(!this.durablePayload || receipt.phase!=='prepared')return;
    if(!payload)throw new PhotoWriteErrorV1('invalid');
    await tx.query("SELECT student_photos.stage_payload_v1($1::uuid,$2::uuid,$3::uuid,decode($4,'hex'),decode($5,'hex'))",
      [receipt.studentUid,receipt.actorId,receipt.requestId,hex(payload.portrait),hex(payload.avatar)]);
  }
  /** Reservation and verified recovery bytes commit in the SAME transaction.
   * Removal revokes immediately; replacement retains the old family until commit. */
  async claim(contextInput:PhotoWriteContextV1,commandInput:PhotoWriteCommandV1,planInput:PhotoWritePlanV1,
    payload?:PhotoPreparedPayloadV1):Promise<PhotoWriteReceiptV1> {
    const context=photoWriteContextV1.parse(contextInput),command=photoWriteCommandV1.parse(commandInput);
    const plan=photoWritePlanV1.parse(planInput); assertPhotoWritePlanV1(command,plan);
    const inputHash=await photoWriteFingerprintV1(context,command,plan);
    return this.transaction(async tx=>{
      await tx.query('INSERT INTO student_photos.photo_family_v1(student_uid) VALUES ($1::uuid) ON CONFLICT DO NOTHING',[context.studentUid]);
      const family=await this.family(tx,context.studentUid),existing=await this.receipt(tx,context,command.requestId);
      if(existing){
        if(existing.inputHash!==inputHash)throw new PhotoWriteErrorV1('receipt-conflict');
        await this.stage(tx,existing,payload); return existing;
      }
      if(family.pending!==null)throw new PhotoWriteErrorV1('busy');
      if(family.revision!==command.expectedRevision)throw new PhotoWriteErrorV1('conflict');
      if(command.kind==='avatar'&&!family.assets.portrait)throw new PhotoWriteErrorV1('not-found');
      const removing=command.kind==='remove';
      const receipt:PhotoWriteReceiptV1={...context,...command,inputHash,plan,previous:family.assets,
        assets:removing?emptyAssets():family.assets,
        cleanup:removing?Object.values(family.assets).filter((asset):asset is PhotoAssetV1=>asset!==null):[],
        phase:removing?'committed':'prepared'};
      await tx.query(`INSERT INTO student_photos.write_operation_v1(request_id,student_uid,actor_id,input_hash,receipt)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::text::jsonb)`,[receipt.requestId,context.studentUid,context.actorId,inputHash,JSON.stringify(receipt)]);
      await tx.query(`UPDATE student_photos.photo_family_v1 SET pending_request=$2::uuid,
        revision=$3::uuid,assets=$4::text::jsonb,updated_at=statement_timestamp() WHERE student_uid=$1::uuid`,
        [context.studentUid,command.requestId,removing?command.requestId:family.revision,JSON.stringify(receipt.assets)]);
      await this.stage(tx,receipt,payload);
      await this.audit(tx,receipt,removing?'committed':'prepared'); return receipt;
    });
  }
  async commit(contextInput:PhotoWriteContextV1,requestIdInput:string,uploadedInput:PhotoAssetsV1):Promise<PhotoWriteReceiptV1> {
    const context=photoWriteContextV1.parse(contextInput),requestId=photoWriteCommandV1.shape.requestId.parse(requestIdInput);
    const uploaded=photoAssetsV1.parse(uploadedInput);
    return this.transaction(async tx=>{
      const family=await this.family(tx,context.studentUid),receipt=await this.receipt(tx,context,requestId);
      if(!receipt||receipt.kind==='remove')throw new PhotoWriteErrorV1('invalid');
      assertPhotoUploadedAssetsV1(receipt,uploaded);
      const assets=receipt.kind==='avatar'?{portrait:receipt.previous.portrait,avatar:uploaded.avatar}:uploaded;
      if(receipt.phase!=='prepared'){
        if(JSON.stringify(assets)!==JSON.stringify(receipt.assets))throw new PhotoWriteErrorV1('receipt-conflict');
        return receipt;
      }
      if(family.pending!==requestId||family.revision!==receipt.expectedRevision)throw new PhotoWriteErrorV1('conflict');
      const keep=new Set(Object.values(assets).filter((a):a is PhotoAssetV1=>a!==null).map(photoAssetKeyV1));
      const cleanup=Object.values(receipt.previous).filter((a):a is PhotoAssetV1=>a!==null&&!keep.has(photoAssetKeyV1(a)));
      const committed:PhotoWriteReceiptV1={...receipt,phase:'committed',assets,cleanup};
      await tx.query(`UPDATE student_photos.photo_family_v1 SET assets=$2::text::jsonb,revision=$3::uuid,
        updated_at=statement_timestamp() WHERE student_uid=$1::uuid`,[context.studentUid,JSON.stringify(assets),requestId]);
      await this.store(tx,committed); await this.audit(tx,committed,'committed'); return committed;
    });
  }
  async acknowledgeCleanup(contextInput:PhotoWriteContextV1,requestIdInput:string,asset:PhotoAssetV1,
    outcome:'deleted'|'already-absent'):Promise<PhotoWriteReceiptV1> {
    const context=photoWriteContextV1.parse(contextInput),requestId=photoWriteCommandV1.shape.requestId.parse(requestIdInput);
    if(!['deleted','already-absent'].includes(outcome))throw new PhotoWriteErrorV1('invalid');
    return this.transaction(async tx=>{
      const family=await this.family(tx,context.studentUid),receipt=await this.receipt(tx,context,requestId);
      if(!receipt||receipt.phase==='prepared')throw new PhotoWriteErrorV1('invalid');
      if(receipt.phase==='complete')return receipt;
      if(family.pending!==requestId||family.revision!==requestId)throw new PhotoWriteErrorV1('conflict');
      const key=photoAssetKeyV1(asset);
      if(Object.values(family.assets).some(live=>live&&photoAssetKeyV1(live)===key))throw new PhotoWriteErrorV1('invalid');
      const pending=receipt.cleanup.find(item=>photoAssetKeyV1(item)===key);
      if(!pending)return receipt;
      if(pending.etag!==asset.etag)throw new PhotoWriteErrorV1('conflict');
      const updated={...receipt,cleanup:receipt.cleanup.filter(item=>photoAssetKeyV1(item)!==key)};
      await this.store(tx,updated);await this.audit(tx,updated,'cleanup-'+outcome,key);return updated;
    });
  }
  /** Completion also clears the private staged pixels through the schema trigger. */
  async complete(contextInput:PhotoWriteContextV1,requestIdInput:string):Promise<PhotoWriteReceiptV1> {
    const context=photoWriteContextV1.parse(contextInput),requestId=photoWriteCommandV1.shape.requestId.parse(requestIdInput);
    return this.transaction(async tx=>{
      const family=await this.family(tx,context.studentUid),receipt=await this.receipt(tx,context,requestId);
      if(!receipt||receipt.phase==='prepared'||receipt.cleanup.length)throw new PhotoWriteErrorV1('invalid');
      if(receipt.phase==='complete')return receipt;
      if(family.pending!==requestId||family.revision!==requestId)throw new PhotoWriteErrorV1('conflict');
      const completed:PhotoWriteReceiptV1={...receipt,phase:'complete'};
      await this.store(tx,completed);
      await tx.query('UPDATE student_photos.photo_family_v1 SET pending_request=NULL WHERE student_uid=$1::uuid',[context.studentUid]);
      await this.audit(tx,completed,'complete');return completed;
    });
  }
}

import {
  photoWriteContextV1, photoWriteCommandV1, photoWritePlanV1, assertPhotoWritePlanV1, PhotoWriteErrorV1,
  type PhotoWriteContextV1, type PhotoWriteCommandV1, type PhotoWritePlanV1, type PhotoAssetV1,
  type PhotoVariantMetadataV1, type PhotoWriteReceiptV1,
} from '../../shared/student-photos/write-v1';
import type { PhotoWriteRepositoryV1 } from './write-repository-v1';

export type PhotoVariantV1='portrait'|'avatar';
export interface ValidatedPhotoBytesV1 {bytes:Uint8Array;width:number;height:number}
export interface PhotoWritePortsV1 {
  authorize(context:PhotoWriteContextV1):Promise<void>;
  validate(bytes:Uint8Array,variant:PhotoVariantV1,signal:AbortSignal):Promise<ValidatedPhotoBytesV1>;
  upload(input:{context:PhotoWriteContextV1;requestId:string;variant:PhotoVariantV1;bytes:Uint8Array;
    metadata:PhotoVariantMetadataV1;signal:AbortSignal}):Promise<PhotoAssetV1>;
  remove(asset:PhotoAssetV1,signal:AbortSignal):Promise<'deleted'|'already-absent'>;
  /** Production publishes these exact final bytes before acknowledging completion.
   * Failure is recoverable finalization, never a false failure of the committed write. */
  publish?(context:PhotoWriteContextV1,receipt:PhotoWriteReceiptV1,images:PhotoWriteInputV1,signal:AbortSignal):Promise<void>;
}
export interface PhotoWriteInputV1 {portrait:Uint8Array|null;avatar:Uint8Array|null}
export type PhotoWriteResultV1 =
  |{state:'pending';requestId:string;stage:'upload'|'commit'}
  |{state:'committed';requestId:string;revision:string;cleanupPending:boolean};
async function metadataOf(value:ValidatedPhotoBytesV1):Promise<PhotoVariantMetadataV1>{
  const copy=new Uint8Array(value.bytes);
  try{
    const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',copy.buffer)),b=>b.toString(16).padStart(2,'0')).join('');
    return{width:value.width,height:value.height,byteSize:value.bytes.length,sha256};
  }finally{copy.fill(0);}
}
const resultOf=(requestId:string,cleanupPending:boolean):PhotoWriteResultV1=>({state:'committed',requestId,revision:requestId,cleanupPending});
function assertByteBudget(bytes:Uint8Array,variant:PhotoVariantV1):void{
  if(!(bytes instanceof Uint8Array)||bytes.length<20||bytes.length>(variant==='portrait'?131072:65536))throw new PhotoWriteErrorV1('invalid');
}
function clearValidated(values:Partial<Record<PhotoVariantV1,ValidatedPhotoBytesV1>>):void{
  for(const value of Object.values(values))value?.bytes.fill(0);
}
/** Codec, authorization, durable journal and remote storage are mandatory production ports. */
export class PhotoWriteCoordinatorV1 {
  constructor(private readonly repository:Pick<PhotoWriteRepositoryV1,'claim'|'commit'|'acknowledgeCleanup'|'complete'>,
    private readonly ports:PhotoWritePortsV1){}
  private async prepare(command:PhotoWriteCommandV1,input:PhotoWriteInputV1,signal:AbortSignal){
    const validated:Partial<Record<PhotoVariantV1,ValidatedPhotoBytesV1>>={};
    const plan:PhotoWritePlanV1={portrait:null,avatar:null};
    try{
      for(const variant of ['portrait','avatar'] as const){
        const wanted=variant==='portrait'?command.kind==='replace':command.kind!=='remove';
        const bytes=input[variant];
        if(wanted!==(bytes!==null))throw new PhotoWriteErrorV1('invalid');
        if(!bytes)continue;
        assertByteBudget(bytes,variant);signal.throwIfAborted();
        const copy=new Uint8Array(bytes);let result:ValidatedPhotoBytesV1|undefined;
        try{
          result=await this.ports.validate(copy,variant,signal);signal.throwIfAborted();assertByteBudget(result.bytes,variant);
          const stable={...result,bytes:new Uint8Array(result.bytes)};validated[variant]=stable;plan[variant]=await metadataOf(stable);
        }finally{copy.fill(0);if(result?.bytes instanceof Uint8Array)result.bytes.fill(0);}
      }
      const checked=photoWritePlanV1.parse(plan);assertPhotoWritePlanV1(command,checked);return{validated,plan:checked};
    }catch(error){clearValidated(validated);throw error;}
  }
  async execute(contextInput:PhotoWriteContextV1,commandInput:PhotoWriteCommandV1,input:PhotoWriteInputV1,signal:AbortSignal):Promise<PhotoWriteResultV1>{
    const context=photoWriteContextV1.parse(contextInput),command=photoWriteCommandV1.parse(commandInput);
    signal.throwIfAborted();await this.ports.authorize(context);
    const prepared=await this.prepare(command,input,signal);
    const finalImages:PhotoWriteInputV1={portrait:prepared.validated.portrait?.bytes??null,avatar:prepared.validated.avatar?.bytes??null};
    try{
      signal.throwIfAborted();await this.ports.authorize(context);signal.throwIfAborted();
      let receipt=await this.repository.claim(context,command,prepared.plan,finalImages);
      if(receipt.phase==='complete')return resultOf(command.requestId,false);
      if(receipt.phase==='prepared'){
        const uploaded:{portrait:PhotoAssetV1|null;avatar:PhotoAssetV1|null}={portrait:null,avatar:null};
        try{
          for(const variant of ['portrait','avatar'] as const){
            const data=prepared.validated[variant],metadata=prepared.plan[variant];if(!data||!metadata)continue;
            signal.throwIfAborted();uploaded[variant]=await this.ports.upload({context,requestId:command.requestId,variant,bytes:data.bytes,metadata,signal});
          }
        }catch{return{state:'pending',requestId:command.requestId,stage:'upload'};}
        if(signal.aborted)return{state:'pending',requestId:command.requestId,stage:'commit'};
        await this.ports.authorize(context);
        if(signal.aborted)return{state:'pending',requestId:command.requestId,stage:'commit'};
        try{receipt=await this.repository.commit(context,command.requestId,uploaded);}
        catch(error){
          if(error instanceof PhotoWriteErrorV1)throw error;
          return{state:'pending',requestId:command.requestId,stage:'commit'};
        }
      }
      if(this.ports.publish){
        try{await this.ports.authorize(context);signal.throwIfAborted();await this.ports.publish(context,receipt,finalImages,signal);}
        catch{return resultOf(receipt.requestId,true);}
      }
      return await this.cleanup(context,receipt,signal);
    }finally{clearValidated(prepared.validated);}
  }
  private async cleanup(context:PhotoWriteContextV1,initial:PhotoWriteReceiptV1,signal:AbortSignal):Promise<PhotoWriteResultV1>{
    let receipt=initial;
    for(const asset of initial.cleanup){
      if(signal.aborted)return resultOf(receipt.requestId,true);
      try{
        await this.ports.authorize(context);if(signal.aborted)return resultOf(receipt.requestId,true);
        const outcome=await this.ports.remove(asset,signal);
        receipt=await this.repository.acknowledgeCleanup(context,receipt.requestId,asset,outcome);
      }catch{return resultOf(receipt.requestId,true);}
    }
    if(signal.aborted)return resultOf(receipt.requestId,true);
    try{await this.repository.complete(context,receipt.requestId);}catch{return resultOf(receipt.requestId,true);}
    return resultOf(receipt.requestId,false);
  }
}

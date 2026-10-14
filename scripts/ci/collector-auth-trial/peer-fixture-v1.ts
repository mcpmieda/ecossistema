// QA-only stdin peer. Never a server, credential producer or production service.
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {verifyCollectorPairingV1} from '../../../server/collector/pairing-proof-v1';
import {issueCollectorChallengeV1,verifyCollectorDeviceProofV1} from '../../../server/collector/device-proof-v1';
if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
async function main(){
  const value=JSON.parse(readFileSync(0,'utf8'));
  if(value.operation==='pairing'){
    await verifyCollectorPairingV1(value.body,value.now);return {valid:true};
  }
  if(value.operation==='challenge')return await issueCollectorChallengeV1(value.record,value.now,value.purpose,value.requestHash);
  if(value.operation==='verify'){
    await verifyCollectorDeviceProofV1({record:value.record,challenge:value.challenge,signature:value.signature,now:value.now,purpose:value.purpose});
    return {valid:true};
  }
  throw new Error('unsupported-fixture-operation');
}
main().then(result=>process.stdout.write(JSON.stringify(result)),()=>{process.stdout.write(JSON.stringify({valid:false}));process.exitCode=1;});

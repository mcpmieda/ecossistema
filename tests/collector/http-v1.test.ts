import { describe,it,expect,vi } from 'vitest';
import { handleCollectorAccessRequestV1,type CollectorAccessPortV1 } from '../../server/collector/http-v1';
import { CollectorAccessErrorV1 } from '../../server/collector/access-service-v1';
const device='11111111-1111-4111-8111-111111111111';
function request(body:unknown,path='access',headers:Record<string,string>={}) {
  return new Request('https://admin.escolaieda.com/api/frequency-collector/'+path,{method:'POST',
    headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
}
const input={deviceId:device,nonce:'a'.repeat(43),signature:'b'.repeat(86)};
const port=()=>({challenge:vi.fn(),authorize:vi.fn()} as unknown as CollectorAccessPortV1);
describe('collector-only HTTP adapter',()=>{
  it('is unavailable by default, never accepts an existing session as collector access',async()=>{
    const result=await handleCollectorAccessRequestV1(request(input,'access',{Cookie:'session=synthetic',Authorization:'Bearer synthetic'}),null);
    expect(result?.status).toBe(503);expect(await result?.json()).toHaveProperty('code','ACCESS_NOT_CONFIGURED');
  });
  it('rejects cross-origin browser access before touching the broker',async()=>{
    const service=port(),result=await handleCollectorAccessRequestV1(request(input,'access',{Origin:'https://other.invalid'}),service);
    expect(result?.status).toBe(403);expect(service.authorize).not.toHaveBeenCalled();
  });
  it('rejects oversized, extra fields, methods and malformed proof without echoing secrets',async()=>{
    const service=port();
    for(const value of [{...input,password:'PRIVATE_SENTINEL'},{...input,signature:'bad'},{...input,nonce:'x'.repeat(3000)}]){
      const result=await handleCollectorAccessRequestV1(request(value),service);
      expect(result?.status).toBe(400);expect(await result?.text()).not.toContain('PRIVATE_SENTINEL');
    }
    expect(service.authorize).not.toHaveBeenCalled();
    expect((await handleCollectorAccessRequestV1(new Request('https://admin.escolaieda.com/api/frequency-collector/access'),service))?.status).toBe(405);
    expect(await handleCollectorAccessRequestV1(new Request('https://admin.escolaieda.com/api/me'),service)).toBeNull();
  });
  it('does not serialize an accidental private value returned by a server adapter',async()=>{
    const service=port();vi.mocked(service.authorize).mockResolvedValue({refresh_token:'PRIVATE_SENTINEL'} as never);
    const result=await handleCollectorAccessRequestV1(request(input),service);
    expect(result?.status).toBe(400);expect(await result?.text()).not.toContain('PRIVATE_SENTINEL');
  });
  it('returns only a valid bounded collector receipt with no-store',async()=>{
    const service=port(),now=Date.now();
    const reply={contractVersion:2,authenticated:true,authorized:true,capability:'frequency.collector.use',identityKey:'collector-fixture',
      checkedAt:new Date(now).toISOString(),expiresAt:new Date(now+300_000).toISOString(),revocationChecked:true,
      directoryCheckedAt:new Date(now).toISOString(),directoryValidUntil:new Date(now+300_000).toISOString()};
    vi.mocked(service.authorize).mockResolvedValue(reply as never);
    const result=await handleCollectorAccessRequestV1(request(input),service);
    expect(result?.status).toBe(200);expect(result?.headers.get('Cache-Control')).toBe('no-store');expect(await result?.json()).toEqual(reply);
    vi.mocked(service.authorize).mockRejectedValue(new CollectorAccessErrorV1('denied'));
    expect((await handleCollectorAccessRequestV1(request(input),service))?.status).toBe(403);
  });
});

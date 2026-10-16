import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe,it,expect} from 'vitest';

const workflow=readFileSync('.github/workflows/deploy-cloudflare-pages.yml','utf8').replace(/\r\n/g,'\n');
const source=workflow.split("node --input-type=module <<'NODE'\n")[1]?.split('\n          NODE')[0]?.replace(/^ {10}/gm,'');
const approved=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
function configure(config:typeof approved){
  const directory=mkdtempSync(join(tmpdir(),'collector-bindings-'));
  try{
    writeFileSync(join(directory,'wrangler.jsonc'),JSON.stringify(config));
    const result=spawnSync(process.execPath,['--input-type=module'],{input:source,cwd:directory,encoding:'utf8'});
    return {status:result.status,config:JSON.parse(readFileSync(join(directory,'wrangler.jsonc'),'utf8'))};
  }finally{rmSync(directory,{recursive:true,force:true});}
}
describe('official production binding configuration',()=>{
  it('preserves existing services and vars while deploying the two dedicated pools',()=>{
    expect(source).toBeTruthy();
    const result=configure(approved);
    expect(result.status).toBe(0);
    expect(result.config.env.production.hyperdrive).toEqual(approved.hyperdrive);
    expect(result.config.env.production.services).toEqual(approved.services);
    expect(result.config.env.production.vars).toEqual(approved.vars);
    expect(result.config.env.production.d1_databases).toEqual([]);
    expect(JSON.stringify(result.config)).not.toContain('COLLECTOR_REFRESH_KEY');
  });
  it.each(['shared-pool','extra-binding','disabled','wrong-origin'])('rejects %s before writing production configuration',kind=>{
    const config=structuredClone(approved);
    if(kind==='shared-pool')config.hyperdrive[1].id=config.hyperdrive[0].id;
    if(kind==='extra-binding')config.hyperdrive.push({binding:'UNAPPROVED_DB',id:'a'.repeat(32)});
    if(kind==='disabled')config.vars.COLLECTOR_ENABLED='false';
    if(kind==='wrong-origin')config.vars.OFFICIAL_ORIGIN='https://example.invalid';
    const result=configure(config);
    expect(result.status).not.toBe(0);
    expect(result.config).toEqual(config);
  });
});

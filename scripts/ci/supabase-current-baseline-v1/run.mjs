import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
const root = path.dirname(fileURLToPath(import.meta.url));
const docs = path.resolve(root, '../../../docs/infra/supabase-current-baseline-v1');
const read = file => JSON.parse(fs.readFileSync(path.join(docs,file),'utf8'));
const snapshot = read('snapshot.json');
const manifest = read('manifest.json');
const queries = read('catalog-queries.json');
const baseline = fs.readFileSync(path.join(docs,'baseline.sql'),'utf8');
const candidate = fs.readFileSync(path.join(root,'incremental.sql'),'utf8');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
assert.equal(sha(baseline), manifest.baselineSha256, 'baseline bytes changed');
assert.equal(sha(fs.readFileSync(path.join(docs,'snapshot.json'))), manifest.snapshotSha256, 'snapshot bytes changed');
const candidateHash = read('test-manifest.json').candidateSha256;
function hashGuard(bytes) { assert.equal(sha(bytes),candidateHash,'candidate hash changed'); }
hashGuard(candidate);
assert.throws(()=>hashGuard(candidate+'\n--changed'),/candidate hash changed/);
const known = new Set(manifest.functions.filter(x=>x.source).map(x=>x.schema_name+'.'+x.proname));
const schemas = snapshot.inventory.schemas.map(x=>x.nspname);
const keys = ['relations','columns','constraints','indexes','sequences','policies','triggers','views','types','default_acls','function_hashes','functions','function_extra','acls','column_acls'];
const wrapped = key => '('+queries[key].trim().replace(/;$/,'')+')';
function normalize(key, rows) {
  let copy = rows.map(row=>({...row}));
  if (key==='columns') {
    const ordinal = new Map();
    for (const row of copy) {
      const relation = row.schema_name+'.'+row.relname;
      const next = (ordinal.get(relation)||0)+1;
      ordinal.set(relation,next);
      row.logical_ordinal=next;
    }
  }
  if (key==='functions') copy=copy.filter(x=>known.has(x.nspname+'.'+x.proname));
  if (key==='function_extra'||key==='function_hashes') copy=copy.filter(x=>known.has(x.schema_name+'.'+x.proname));
  if (key==='acls') copy=copy.filter(x=>x.kind!=='function'||known.has(x.schema_name+'.'+x.object_name));
  for(const row of copy) {
    // ACL arrays are checked semantically in aclexplode results; physical attnum holes are not reproduced.
    if(key==='relations'||key==='columns'||key==='functions') delete row.acl;
    if(key==='columns') delete row.attnum;
    if(key==='policies'&&typeof row.roles==='string') row.roles=row.roles.slice(1,-1).split(',');
    if(key==='sequences') for(const field of ['seqstart','seqincrement','seqmax','seqmin','seqcache']) row[field]=String(row[field]);
  }
  return copy.map(row=>Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b)))).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
const expected = Object.fromEntries(keys.map(key=>[key,normalize(key,key==='functions'?snapshot.inventory.functions:snapshot[key])]));
assert.equal(manifest.functions.filter(x=>!x.source).length,5,'opaque exclusions changed');
if(!process.argv.includes('--native')) { console.log('Artifact hashes and declared subset contract passed; PostgreSQL not executed.'); process.exit(0); }
assert.equal(process.env.GITHUB_ACTIONS,'true','Native execution restricted to disposable GitHub CI');
assert.ok(!Object.keys(process.env).some(x=>x.startsWith('PG')),'Ambient PG configuration prohibited');
const env={...process.env,PGPASSFILE:'/nonexistent-baseline-passfile',PGSERVICEFILE:'/nonexistent-baseline-servicefile'};
const args=['-X','--no-password','-h','127.0.0.1','-p','55474','-U','postgres','-d','current_baseline_synthetic','-v','ON_ERROR_STOP=1','-qAt'];
function exec(sql, expectedError) {
 const result=spawnSync('/usr/bin/psql',args,{input:sql,encoding:'utf8',env,timeout:60000,maxBuffer:8*1024*1024});
 if(result.error)throw result.error;
 if(expectedError){assert.notEqual(result.status,0,'expected SQL refusal');assert.match(result.stderr,expectedError);}
 else assert.equal(result.status,0,result.stderr);
 return result.stdout.trim();
}
function json(sql){return JSON.parse(exec(sql));}
assert.equal(exec("SELECT current_setting('server_version_num')"),'170006');
assert.equal(exec('SELECT current_database()'),'current_baseline_synthetic');
assert.equal(exec("SELECT count(*) FROM pg_namespace WHERE nspname IN ('gradebook','student_portal','student_photos','system_health','baseline_trial')"),'0');
const pairs=Array.from({length:54},(_,i)=>[String(i+1).padStart(3,'0'),'synthetic_'+(i+1)]);
const vals=pairs.map(([v,n])=>"('"+v+"','"+n+"')").join(',');
let created=false;
const report={head:process.env.TRIAL_HEAD_SHA,postgresVersion:'17.6',baselineHash:manifest.baselineSha256,candidateHash,opaqueFunctions:manifest.functions.filter(x=>!x.source).map(x=>x.schema_name+'.'+x.proname),catalogComparisons:[],cases:[],fullFunctionalEquivalence:false,supabaseExternalIntegration:false};
try {
 exec(baseline);
 created=true;
 for(const key of keys) {
  const actual=normalize(key,json('SELECT coalesce(json_agg(t),\'[]\'::json) FROM '+wrapped(key)+' t'));
  try{assert.deepEqual(actual,expected[key]);}catch(error){
   const different=actual.find((x,i)=>JSON.stringify(x)!==JSON.stringify(expected[key][i]));
   fs.writeFileSync(path.join(root,'catalog-difference.json'),JSON.stringify({key,actualCount:actual.length,expectedCount:expected[key].length,actual:different,expected:expected[key][actual.indexOf(different)]},null,2));
   throw new Error('Catalog mismatch: '+key,{cause:error});
  }
  report.catalogComparisons.push({key,count:actual.length,passed:true});
 }
 report.cases.push('empty database structural subset reconstruction');
 // Explicitly check no stubs have replaced opaque functions.
 assert.equal(exec("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='student_portal' AND p.proname IN ('assert_year_reset_locks_v1','ensure_year_coordination_v1','inspect_year_reset_guard_v1','publication_source_rows_v3','synchronize_profiles_v1')"),'0');
 exec("CREATE SCHEMA baseline_trial; CREATE TABLE baseline_trial.ledger(version text PRIMARY KEY,name text NOT NULL); INSERT INTO baseline_trial.ledger VALUES "+vals);
 const fingerprintSQL="SELECT md5(jsonb_build_object("+keys.map(key=>"'"+key+"',(SELECT coalesce(jsonb_agg(t),'[]'::jsonb) FROM "+wrapped(key)+" t)").join(',')+")::text)";
 const fingerprint=exec(fingerprintSQL);
 const ledgerSQL="SELECT md5(json_agg(t ORDER BY version)::text) FROM (SELECT version,name FROM baseline_trial.ledger) t";
 const ledgerHash=exec(ledgerSQL);
 const fingerprintExpr=fingerprintSQL.replace(/^SELECT /,'');
 const ledgerExpr=ledgerSQL;
 function transaction(bytes,{failure=false,hold=false}={}) {
  hashGuard(bytes);
  return `BEGIN; SELECT pg_advisory_xact_lock(1274,1); LOCK TABLE baseline_trial.ledger IN ACCESS EXCLUSIVE MODE;
${hold?"SELECT 'lock-held'; SELECT pg_sleep(1);":''}
DO $guard$ BEGIN
 IF EXISTS(SELECT 1 FROM baseline_trial.ledger WHERE version='synthetic_new_055') THEN RAISE EXCEPTION 'repeat blocked'; END IF;
 IF (${ledgerExpr}) <> '${ledgerHash}' THEN RAISE EXCEPTION 'ledger drift blocked'; END IF;
 IF (${fingerprintExpr}) <> '${fingerprint}' THEN RAISE EXCEPTION 'catalog drift blocked'; END IF;
END $guard$;
${bytes}
INSERT INTO baseline_trial.ledger VALUES('synthetic_new_055','synthetic_additive_column');
${failure?'SELECT 1/0;':''}
COMMIT;`;
 }
 assert.throws(()=>transaction(candidate+'--altered'),/candidate hash changed/);
 report.cases.push('altered candidate hash rejected');
 exec("UPDATE baseline_trial.ledger SET name='synthetic_drift' WHERE version='001'");
 exec(transaction(candidate),/ledger drift blocked/);
 exec("UPDATE baseline_trial.ledger SET name='synthetic_1' WHERE version='001'");
 exec('ALTER TABLE student_portal.seal_count_cache_v1 DISABLE ROW LEVEL SECURITY');
 exec(transaction(candidate),/catalog drift blocked/);
 exec('ALTER TABLE student_portal.seal_count_cache_v1 ENABLE ROW LEVEL SECURITY');
 assert.equal(exec(fingerprintSQL),fingerprint);
 report.cases.push('live ledger and RLS drift rejected inside transaction');
 exec(transaction(candidate,{failure:true}),/division by zero/);
 assert.equal(exec(fingerprintSQL),fingerprint);
 assert.equal(exec(ledgerSQL),ledgerHash);
 report.cases.push('real failure rolls back DDL and ledger');
 function start(sql) {
  const child=spawn('/usr/bin/psql',args,{env});
  let stdout='',stderr='';
  let signal;const locked=new Promise(resolve=>{signal=resolve;});
  child.stdout.on('data',data=>{stdout+=data; if(stdout.includes('lock-held'))signal();});
  child.stderr.on('data',data=>{stderr+=data;});
  const complete=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));});
  child.stdin.end(sql);
  return {locked,complete};
 }
 const first=start(transaction(candidate,{hold:true}));
 await Promise.race([first.locked,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Lock signal timeout')),10000))]);
 const second=start(transaction(candidate));
 const [a,b]=await Promise.all([first.complete,second.complete]);
 assert.equal(a.status,0,a.stderr);
 assert.notEqual(b.status,0,'second writer must refuse');
 assert.match(b.stderr,/repeat blocked/);
 assert.equal(exec('SELECT count(*) FROM baseline_trial.ledger'),'55');
 const original=json("SELECT json_agg(t ORDER BY version) FROM (SELECT version,name FROM baseline_trial.ledger WHERE version<>'synthetic_new_055') t").map(x=>[x.version,x.name]);
 assert.deepEqual(original,pairs);
 assert.equal(exec("SELECT count(*) FROM pg_attribute WHERE attrelid='student_portal.seal_count_cache_v1'::regclass AND attname='baseline_trial_marker' AND attnotnull"),'1');
 exec(transaction(candidate),/repeat blocked/);
 report.cases.push('two actual concurrent sessions: one commit, one repeat refusal','54 original synthetic pairs plus exactly one delta','repeat application rejected');
 // The additive change preserves ACL, RLS and all captured properties except the declared new column.
 for(const key of keys.filter(x=>x!=='columns')) assert.deepEqual(normalize(key,json("SELECT coalesce(json_agg(t),'[]'::json) FROM "+wrapped(key)+" t")),expected[key],key+' postflight');
 const columns=normalize('columns',json("SELECT coalesce(json_agg(t),'[]'::json) FROM "+wrapped('columns')+" t")).filter(x=>x.attname!=='baseline_trial_marker');
 assert.deepEqual(columns,expected.columns);
 report.cases.push('postflight complete catalog set, ACL and RLS unchanged except declared column');
 assert.equal(exec("SELECT has_table_privilege('student_portal_app','student_portal.seal_count_cache_v1','SELECT') AND NOT has_table_privilege('gradebook_app','student_portal.seal_count_cache_v1','SELECT')"),'t');
 assert.equal(exec("SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname='student_portal_app'"),'t');
 exec("SET ROLE gradebook_app; SELECT * FROM student_portal.seal_count_cache_v1",/permission denied/);
 assert.equal(exec('BEGIN; SET LOCAL ROLE student_portal_app; SELECT count(*) FROM student_portal.seal_count_cache_v1; ROLLBACK;'),'0');
 report.cases.push('effective application role grants and cross-role denial on synthetic empty cache');
 report.passed=true;
 console.log(JSON.stringify(report));
 fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(report,null,2)+'\n');
} finally {
 if(created){
  exec('DROP SCHEMA IF EXISTS baseline_trial CASCADE; '+schemas.map(x=>'DROP SCHEMA IF EXISTS "'+x+'" CASCADE;').join(' ')+' DROP ROLE gradebook_app; DROP ROLE student_portal_app;');
  assert.equal(exec("SELECT count(*) FROM pg_namespace WHERE nspname IN ('gradebook','student_portal','student_photos','system_health','baseline_trial')"),'0');
  console.log('Isolated baseline objects and roles removed.');
 }
}


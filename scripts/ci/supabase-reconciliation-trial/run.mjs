// Synthetic CI experiment only; not a production migration runner.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const candidate = fs.readFileSync(path.join(root, 'candidate.sql'), 'utf8');
const expectedHash = 'dd8cc13846b3b29a6380d8c5f640ed5f010ac155e7b3eb4dfa97bbea4d58bff2';
assert.equal(hash(candidate), expectedHash);
const pairs = Array.from({ length: 54 }, (_, i) => [String(i + 1).padStart(3, '0'), 'synthetic_' + (i + 1)]);
const version = 'synthetic_new_055';
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const values = pairs.map(row => '(' + row.map(quote).join(',') + ')').join(',');
function guard(sql, ledger, schema, baseline) {
  assert.equal(hash(sql), expectedHash, 'hash changed');
  assert.ok(!ledger.some(row => row[0] === version), 'already applied');
  assert.deepEqual(ledger, pairs, 'ledger drift');
  assert.equal(schema, baseline, 'schema/ACL drift');
}
guard(candidate, pairs, 'baseline', 'baseline');
assert.throws(() => guard(candidate + '\n-- changed', pairs, 'baseline', 'baseline'), /hash changed/);
assert.throws(() => guard(candidate, [...pairs, [version, 'synthetic']], 'baseline', 'baseline'), /already applied/);
assert.throws(() => guard(candidate, pairs.slice(1), 'baseline', 'baseline'), /ledger drift/);
assert.throws(() => guard(candidate, pairs, 'changed', 'baseline'), /schema\/ACL drift/);
if (!process.argv.includes('--native')) {
  console.log('Local contract checks passed; PostgreSQL not executed.');
  process.exit(0);
}
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Native execution restricted to disposable GitHub CI');
assert.ok(!Object.keys(process.env).some(key => key.startsWith('PG')), 'Ambient PG settings prohibited');
const env = { ...process.env, PGPASSFILE: '/nonexistent-synthetic-passfile', PGSERVICEFILE: '/nonexistent-synthetic-servicefile' };
function execute(sql, failure = false) {
  const result = spawnSync('psql', ['-X', '--no-password', '-h', '127.0.0.1', '-p', '55473', '-U', 'postgres', '-d', 'reconciliation_synthetic_trial', '-v', 'ON_ERROR_STOP=1', '-At'], { input: sql, encoding: 'utf8', env, timeout: 30000 });
  if (result.error) throw result.error;
  if (failure) {
    assert.notEqual(result.status, 0, 'Injected SQL failure must fail');
    assert.match(result.stderr, /division by zero/);
  } else assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
assert.equal(execute("SELECT current_setting('server_version_num')"), '170006');
assert.equal(execute('SELECT current_database()'), 'reconciliation_synthetic_trial');
assert.equal(execute("SELECT count(*) FROM pg_namespace WHERE nspname='trial_private'"), '0');
assert.equal(execute("SELECT count(*) FROM pg_roles WHERE rolname='synthetic_trial_reader'"), '0');
const ledger = () => JSON.parse(execute("SELECT coalesce(json_agg(row_to_json(t)),'[]'::json) FROM (SELECT version,name FROM trial_private.ledger ORDER BY version) t")).map(row => [row.version, row.name]);
const catalog = () => execute("SELECT coalesce(json_agg(t ORDER BY relname)::text,'[]') FROM (SELECT c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relowner,c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='trial_private') t");
let fixtureCreated = false;
try {
  execute(`BEGIN; CREATE SCHEMA trial_private; CREATE ROLE synthetic_trial_reader NOLOGIN; CREATE TABLE trial_private.ledger(version text PRIMARY KEY,name text NOT NULL); INSERT INTO trial_private.ledger VALUES ${values}; COMMIT;`);
  fixtureCreated = true;
  const baseline = catalog();
  function apply(sql, fail = false) {
    guard(sql, ledger(), catalog(), baseline);
    execute(`BEGIN; LOCK TABLE trial_private.ledger IN ACCESS EXCLUSIVE MODE;
DO $guard$ BEGIN
 IF (SELECT count(*) FROM trial_private.ledger)<>54 OR EXISTS ((SELECT version,name FROM trial_private.ledger) EXCEPT (VALUES ${values})) THEN RAISE EXCEPTION 'ledger drift in transaction'; END IF;
END $guard$;
${sql}
INSERT INTO trial_private.ledger VALUES ('synthetic_new_055','synthetic_additive_cache');
${fail ? 'SELECT 1/0;' : ''}
COMMIT;`, fail);
  }
  // Guards inspect actual database state, and reject before candidate DDL.
  assert.throws(() => apply(candidate + '\n-- changed'), /hash changed/);
  execute("UPDATE trial_private.ledger SET name='synthetic_drift' WHERE version='001'");
  assert.throws(() => apply(candidate), /ledger drift/);
  execute("UPDATE trial_private.ledger SET name='synthetic_1' WHERE version='001'");
  execute('ALTER TABLE trial_private.ledger ENABLE ROW LEVEL SECURITY');
  assert.throws(() => apply(candidate), /schema\/ACL drift/);
  execute('ALTER TABLE trial_private.ledger DISABLE ROW LEVEL SECURITY');
  assert.equal(catalog(), baseline);
  // Real SQL error after DDL and ledger INSERT: psql exits and transaction rolls back.
  apply(candidate, true);
  assert.deepEqual(ledger(), pairs);
  assert.equal(catalog(), baseline);
  assert.equal(execute("SELECT to_regclass('trial_private.cache_probe') IS NULL"), 't');
  apply(candidate);
  assert.deepEqual(ledger(), [...pairs, [version, 'synthetic_additive_cache']]);
  const appliedCatalog = catalog();
  assert.throws(() => apply(candidate), /already applied/);
  assert.equal(catalog(), appliedCatalog);
  assert.equal(execute("SELECT c.relrowsecurity AND NOT c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='postgres' FROM pg_class c WHERE c.oid='trial_private.cache_probe'::regclass"), 't');
  assert.equal(execute("SELECT count(*) FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid='trial_private.cache_probe'::regclass AND a.grantee=0"), '0');
  execute('INSERT INTO trial_private.cache_probe VALUES (1,42)');
  const denied = spawnSync('psql', ['-X','--no-password','-h','127.0.0.1','-p','55473','-U','postgres','-d','reconciliation_synthetic_trial','-v','ON_ERROR_STOP=1','-At'], { input: 'SET ROLE synthetic_trial_reader; SELECT * FROM trial_private.cache_probe;', encoding:'utf8',env,timeout:30000 });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /permission denied/);
  // Temporary synthetic grant tests effective default-deny RLS, then is rolled back.
  assert.equal(execute('BEGIN; GRANT USAGE ON SCHEMA trial_private TO synthetic_trial_reader; GRANT SELECT ON trial_private.cache_probe TO synthetic_trial_reader; SET LOCAL ROLE synthetic_trial_reader; SELECT count(*) FROM trial_private.cache_probe; ROLLBACK;').split('\n').filter(line => /^[0-9]+$/.test(line)).at(-1), '0');
  assert.equal(catalog(), appliedCatalog);
  assert.deepEqual(ledger(), [...pairs, [version, 'synthetic_additive_cache']]);
  const report = { postgresVersion: '17.6', candidateSha256: expectedHash, head: process.env.TRIAL_HEAD_SHA || null, cases: ['single committed application','repeat rejected','altered hash rejected','live ledger drift rejected','live RLS drift rejected','real SQL failure rolls back DDL and ledger','54 original pairs preserved plus exactly one delta','owner/RLS/PUBLIC ACL verified','effective role access denied','temporary SELECT grant still subject to default-deny RLS'], scope: 'synthetic disposable PostgreSQL; not Supabase external integration', passed: true };
  fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {
  if (fixtureCreated) {
    execute('BEGIN; DROP SCHEMA trial_private CASCADE; DROP ROLE synthetic_trial_reader; COMMIT;');
    assert.equal(execute("SELECT count(*) FROM pg_namespace WHERE nspname='trial_private'"), '0');
    assert.equal(execute("SELECT count(*) FROM pg_roles WHERE rolname='synthetic_trial_reader'"), '0');
    console.log('Synthetic fixture and role removed.');
  }
}

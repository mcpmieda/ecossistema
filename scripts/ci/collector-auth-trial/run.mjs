// Synthetic GitHub CI only. Not a production migration runner.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.resolve(directory, '../../../migrations/collector/0001_device_authorization.sql'), 'utf8');
const sha256 = crypto.createHash('sha256').update(sql).digest('hex');
assert.equal(sha256, 'db339aec4068487cbe8fafc84899fdd30d0918e7e631b93e5144855b042d3114');
const pairingSql = fs.readFileSync(path.resolve(directory, '../../../migrations/collector/0002_pending_pairings.sql'), 'utf8');
const pairingSha256 = crypto.createHash('sha256').update(pairingSql).digest('hex');
assert.equal(pairingSha256, 'dea6d2d6f581ffa09b3e4ebf3576f705673e0f251aa906a16213c10f5a1f856d');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.ok(!Object.keys(process.env).some(key => key.startsWith('PG')));
const environment = { ...process.env, PGPASSFILE: '/nonexistent-collector-test-passfile', PGSERVICEFILE: '/nonexistent-collector-test-servicefile' };
function execute(statement, fail = false) {
  const result = spawnSync('/usr/bin/psql', ['-X', '--no-password', '-h', '127.0.0.1', '-p', '55475',
    '-U', 'postgres', '-d', 'collector_auth_synthetic_trial', '-v', 'ON_ERROR_STOP=1', '-At'],
  { input: statement, env: environment, encoding: 'utf8', timeout: 30_000 });
  if (result.error) throw result.error;
  if (fail) assert.notEqual(result.status, 0);
  else assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
assert.equal(execute("SELECT current_setting('server_version_num')"), '170006');
assert.equal(execute('SELECT current_database()'), 'collector_auth_synthetic_trial');
const schema = () => execute("SELECT to_regnamespace('collector_auth') IS NOT NULL");
assert.equal(schema(), 'f');
execute(`BEGIN; ${sql} SELECT 1/0; COMMIT;`, true);
assert.equal(schema(), 'f', 'Injected failure must roll back all candidate DDL');
execute('CREATE SCHEMA synthetic_ledger; CREATE TABLE synthetic_ledger.migrations(version text PRIMARY KEY,name text NOT NULL);');
execute("INSERT INTO synthetic_ledger.migrations VALUES ('historical_1','synthetic_only');");
execute(`BEGIN; ${sql} INSERT INTO synthetic_ledger.migrations VALUES ('new_collector_2','collector_auth_control'); COMMIT;`);
assert.equal(schema(), 't');
assert.equal(execute("SELECT count(*) FROM pg_tables WHERE schemaname='collector_auth'"), '3');
assert.equal(execute("SELECT count(*) FROM synthetic_ledger.migrations WHERE version='historical_1' AND name='synthetic_only'"), '1');
assert.equal(execute('SELECT count(*) FROM synthetic_ledger.migrations'), '2');
execute(`BEGIN; ${pairingSql} SELECT 1/0; COMMIT;`, true);
assert.equal(execute("SELECT to_regclass('collector_auth.pairings') IS NULL"), 't');
assert.equal(execute('SELECT count(*) FROM synthetic_ledger.migrations'), '2');
execute(`BEGIN; ${pairingSql} INSERT INTO synthetic_ledger.migrations VALUES ('new_collector_3','collector_pending_pairings'); COMMIT;`);
assert.equal(execute("SELECT count(*) FROM pg_tables WHERE schemaname='collector_auth'"), '4');
execute(`BEGIN; ${pairingSql} COMMIT;`, true);
assert.equal(execute('SELECT count(*) FROM synthetic_ledger.migrations'), '3');
execute(`BEGIN; ${sql} COMMIT;`, true);
assert.equal(execute('SELECT count(*) FROM synthetic_ledger.migrations'), '3');
assert.equal(execute("SELECT count(*) FROM collector_auth.oauth_grants"), '0');
execute('CREATE ROLE synthetic_collector_reader NOLOGIN;');
assert.equal(execute("SELECT has_schema_privilege('synthetic_collector_reader','collector_auth','USAGE')"), 'f');
assert.equal(execute("SELECT has_table_privilege('synthetic_collector_reader','collector_auth.oauth_grants','SELECT')"), 'f');
assert.equal(execute("SELECT has_table_privilege('synthetic_collector_reader','collector_auth.pairings','SELECT')"), 'f');
const result = { head: process.env.TRIAL_HEAD_SHA, postgres: '17.6', sha256, pairingSha256,
  synthetic_only: true, production_connected: false, rollback_passed: true,
  single_apply_passed: true, repeat_blocked: true, owner_only_acl_passed: true,
  historical_ledger_preserved: true, mechanism_scope: 'PostgreSQL transaction; not remote Supabase apply_migration' };
fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));

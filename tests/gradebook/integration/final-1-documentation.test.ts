// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const base = 'docs/gradebook/';
const history = `${base}history/pre-final-1/`;
const source = (path: string) => readFileSync(join(root, path), 'utf8');
const currentState = source(`${base}PROJECT_STATE.yaml`);
// FINAL-1 remains an immutable checkpoint, not the executable P2 state.
const state = currentState.split(/^historical_checkpoint_668:\r?\n/mu)[1]!
  .replace(/^ {2}/gmu, '');
// Hash canonical Git bytes, respecting checkout LF/CRLF conversion on Windows.
const blobHash = (path: string) =>
  execFileSync('git', ['hash-object', '--path', path, path], { cwd: root, encoding: 'utf8' }).trim();
function section(name: string): string {
  const lines = state.split(/\r?\n/u);
  const start = lines.indexOf(`${name}:`);
  if (start < 0) throw new Error(`Missing project-state section: ${name}`);
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || /^\s/u.test(lines[end]!))) end += 1;
  return lines.slice(start, end).join('\n');
}

describe('FINAL-1 documentation distinguishes facts, migration debt and historical checkpoints', () => {
  it('keeps the completed BN program separate from the completed Portal P2 release', () => {
    const current = currentState.split(/^historical_checkpoint_668:/mu)[0]!;
    expect(current).toMatch(/^schema_version: 3$/mu);
    expect(current).toContain('executable_issue: null');
    expect(current).toContain('program_status: completed-functional-program-596');
    expect(current).toContain('total_table_count: 31');
    expect(current).toContain('student_identity_table_count: 1');
    expect(current).toContain('materialized_years: [2025, 2026]');
    expect(current).toContain('academic_authority: imported-source');
    expect(current).toContain('part_2_status: technically-complete-release-closed-by-policy');
    expect(current).toContain('gate_g_b: accepted-with-explicit-physical-device-deferrals');
    expect(current).toContain('gate_g_p: passed-technical-release-general-opening-not-authorized');
    expect(current).toContain('population_enabled: false');
    expect(current).toContain('general_school_opening: false');
    expect(current).toContain('managed_backup_rpo_rto: explicitly-deferred-not-implemented');
    expect(state).toBeDefined();
  });
  it('records relational storage as official without declaring every consumer accepted', () => {
    expect(state).toMatch(/^schema_version: 2$/mu);
    expect(section('storage')).toContain(
      'current_official_storage: supabase-postgresql-via-cloudflare-hyperdrive',
    );
    expect(section('storage')).toContain('cutover_completed: true');
    expect(section('storage')).toContain('core_table_count: 19');
    expect(section('storage')).toContain('diagnostic_table_count: 1');
    expect(section('storage')).toContain('council_v3_table_count: 8');
    expect(section('storage')).toContain('total_table_count: 29');
    expect(section('storage')).toContain(
      'relational_bulletin_snapshot_migration: applied-and-postflight-verified-2026-09-11',
    );
    expect(section('runtime')).toContain('global_academic_authority_switch_verified: false');
    expect(section('work_in_progress')).toContain('phase_complete: false');
    expect(section('work_in_progress')).toContain('production_activation_in_this_delivery: false');
    expect(state).not.toMatch(
      /^\s*(?:production_academic_runtime_enabled|production_gate_final):/mu,
    );
  });
  it('has a concrete four-phase queue and separate acceptance and delivery gates', () => {
    expect(section('coordination')).toContain('executable_issue: 668');
    expect(section('coordination')).toContain('current_delivery_issue: 668');
    expect(section('work_in_progress')).toContain('pull_request: 669');
    expect(section('final_phases').match(/phase: FINAL-/gu)).toHaveLength(4);
    for (const issue of [633, 634, 635, 406])
      expect(section('final_phases')).toContain(`issue: ${issue}`);
    expect(section('institutional_delivery')).toContain('issue: 596');
    expect(section('institutional_delivery')).toContain('authority_acceptance_issue: 347');
    expect(section('next_safe_action')).toContain('issue: 668');
  });
  it('records current-only diagnostics separately from preserved academic history', () => {
    expect(section('storage')).toContain(
      'diagnostic_retention: current-evidence-only-replaced-on-next-source-observation',
    );
    expect(section('storage')).toContain('historical_academic_retention: preserved-real-deltas');
    expect(source(`${base}DECISIONS.md`)).toContain('Substitui BN-DEC-017');
    expect(source(`${base}DECISIONS.md`)).toContain('Substitui BN-DEC-021');
  });
  it('preserves the original historical blobs byte for byte', () => {
    const originals = {
      'PROJECT_STATE.yaml': '4dc15e432c723c47f7aa256a060aaa0a0b40c74b',
      'COMECE_AQUI.md': '4068f05bb7cb9a4926f99896f83341d44d2ed5c9',
      'PRODUCTION_READINESS.md': '67a6065b3b009d2c34d0ad02d0945dc5fabed4d8',
      'DECISIONS.md': '32c4b5126563c72593a0f368d80431332bda642d',
    };
    for (const [path, expected] of Object.entries(originals)) {
      expect(blobHash(`${history}${path}`), path).toBe(expected);
    }
  });
  it('maps all exposed consumers and does not conflate file diagnostics with legacy audit', () => {
    const map = source(`${base}CONSUMER_MAP.md`);
    for (const endpoint of [
      'import-persistence',
      'import-diagnostics',
      'operational-workspace',
      'performance',
      'bulletins',
      'reports',
      'council-workspace',
    ])
      expect(map).toContain(`/api/gradebook/${endpoint}`);
    expect(map).toContain('handleGradebookPersistenceAdminRequestV1');
    expect(map).toContain('não é homologação visual conjunta');
    expect(map).not.toContain('/api/gradebook/audit-workspace');
    expect(map).toContain('UI e endpoint dedicado retirados pela #664');
    expect(map).toContain('frontends antigos retirados pela #666');
    expect(map).toContain('não é ainda uma matriz de turma');
    expect(map).toContain('createRelationalWorkspaceV2');
    expect(map).toContain('createRelationalCouncilV3');
  });
  it('documents remaining limits without erasing the atomicity and schema work already tested', () => {
    const readiness = source(`${base}PRODUCTION_READINESS.md`);
    expect(readiness).toContain('Uma migration existente não comprova restore');
    expect(readiness).toContain('transação read-only/repeatable-read');
    expect(readiness).toContain('substituição transacional');
    expect(readiness).toContain('última confirmada no servidor');
    expect(readiness).toContain('A #662 restaurou localmente 120.879 linhas');
    expect(readiness).toContain('SQLSTATE `40001`');
    const contracts = source(`${base}CONTRACTS.md`);
    expect(contracts).toContain('Conselho — única parte preservada do documento antigo');
    expect(contracts).toContain('não modifica contratos compartilhados');
    expect(contracts).toContain('O teste sintético de projeção não é teste de reconstrução');
  });
  it('records actual deployments separately from authenticated acceptance and the security release checkpoint', () => {
    expect(section('baseline')).toContain(
      'last_audited_main_commit: fc6547f1cf994a9f87fe5c01fd80c1b58c5de642',
    );
    expect(section('baseline')).toContain('authorized_deploy_run: 34604746376');
    expect(section('baseline')).toContain('authenticated_post_deploy_smoke_this_session: true');
    expect(section('storage')).toContain('distinct_trigger_count: 3');
    expect(section('storage')).toContain('information_schema_trigger_event_rows: 6');
    expect(section('storage')).toContain('production_data_restore_proven_by_this_pr: false');
    expect(section('runtime')).toContain(
      'diagnostic_atomic_replacement: integrated-pr-636-and-real-postgres-contention-passed-issue-662',
    );
    expect(section('runtime')).toContain(
      'relational_centers_v2: integrated-pr-640-deploy-255-success-awaiting-authenticated-smoke',
    );
    expect(section('runtime')).toContain(
      'relational_performance_v2: integrated-pr-643-deploy-257-success-awaiting-authenticated-smoke',
    );
    expect(section('runtime')).toContain(
      'relational_council_v3: integrated-pr-653-deploy-262-authenticated-read-only-smoke-success',
    );
    expect(section('runtime')).toContain(
      'relational_bulletins_v2: integrated-pr-655-deploy-263-authenticated-read-only-smoke-success',
    );
    expect(section('runtime')).toContain(
      'relational_reports_v2: integrated-pr-657-deploy-264-authenticated-read-only-smoke-success',
    );
    expect(section('runtime')).toContain(
      'relational_current_audit_v2: integrated-pr-659-deploy-265-authenticated-read-only-smoke-success',
    );
    expect(section('runtime')).toContain(
      'relational_teacher_configuration: integrated-pr-661-deploy-266-authenticated-read-only-smoke-success',
    );
    expect(section('runtime')).toContain(
      'real_postgres_contention: diagnostic-advisory-lock-rollback-and-council-cas-passed-issue-662',
    );
    expect(source(`${base}RELATIONAL_REPORTS_V2.md`)).toContain(
      'As operações V2 são somente leitura',
    );
    expect(section('security')).toContain(
      'dependency_remediation: integrated-pr-641-deploy-256-success',
    );
    expect(section('security')).toContain(
      'audited_lock_blob: ad6059ec46be02970b340f97e7cbb585abd79715',
    );
    expect(existsSync(join(root, 'migrations/gradebook-simplified/0001_current_schema.sql'))).toBe(
      true,
    );
    const inspect = source('migrations/gradebook-simplified/inspect_current_schema.sql');
    expect(inspect).toContain('a.attnotnull::text');
    expect(inspect).toContain("WHERE c.contype <> 'n'");
  });
  it('records standing integration authorization without bypassing verification or academic acceptance', () => {
    expect(section('coordination')).toContain(
      'merge_and_deploy: standing-authorization-after-final-head-verification',
    );
    expect(section('coordination')).toContain('authorization_comment: 5618750384');
    const decisions = source(`${base}DECISIONS.md`);
    expect(decisions).toContain('BN-DEC-023');
    expect(decisions).toContain('sem nova confirmação por PR');
    expect(source('AGENTS.md')).toContain('Não contorne checks');
    expect(source('AGENTS.md')).toContain('CI no head final');
    expect(section('security')).toContain('automatic_authority_activation: forbidden');
    const integrationGate = source('.github/workflows/validate-pull-request.yml');
    // The reviewed gate now validates the actual Cloudflare Pages route
    // artifact. Keep an exact Git blob pin AND a functional safety invariant:
    // this is not permission to bypass checks or academic acceptance.
    expect(integrationGate).toContain("production-inputs/dist/_routes.json");
    expect(integrationGate).toContain('/frequency-collector/*');
    expect(blobHash('.github/workflows/validate-pull-request.yml'))
      .toBe('ed496d6884f55f1da27c655bc2d8e2e281954f4d');
  });
  it('keeps the canonical local documentation links resolvable', () => {
    const pages = [
      'README.md',
      'COMECE_AQUI.md',
      'DECISIONS.md',
      'ARCHITECTURE.md',
      'ACADEMIC_CONTEXT.md',
      'CONTRACTS.md',
      'ROADMAP.md',
      'ISSUE_MAP.md',
      'PRODUCTION_READINESS.md',
      'CONSUMER_MAP.md',
      'CURRENT_SCHEMA_AND_DIAGNOSTICS.md',
      'RELATIONAL_CENTERS_V2.md',
      'SECURITY_REMEDIATION_637.md',
      'RELATIONAL_PERFORMANCE_V2.md',
      'PERFORMANCE_LENSES_V3.md',
      'FINAL2_SOURCE_DESKTOP_646.md',
      'TERM_COMPARISON_2026_V4.md',
      'RELATIONAL_COUNCIL_V3.md',
      'RELATIONAL_BULLETINS_V2.md',
      'RELATIONAL_REPORTS_V2.md',
      'RELATIONAL_CURRENT_AUDIT_V2.md',
      'RELATIONAL_TEACHER_CONFIGURATION_660.md',
      'RELATIONAL_RECOVERY_REHEARSAL_662.md',
      'LEGACY_AUDIT_RETIREMENT_664.md',
      'LEGACY_FRONTEND_RETIREMENT_666.md',
      'PERFORMANCE_MEASUREMENTS_668.md',
    ];
    for (const page of pages) {
      const fullPath = join(root, base, page);
      for (const match of source(`${base}${page}`).matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/gu)) {
        const target = match[1]!;
        if (/^(?:https?:|mailto:)/u.test(target)) continue;
        expect(existsSync(resolve(dirname(fullPath), target)), `${page} → ${target}`).toBe(true);
      }
    }
  });
});

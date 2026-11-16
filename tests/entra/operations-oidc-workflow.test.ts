// @vitest-environment node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/entra-operations-audit.yml', 'utf8');

describe('Entra Operations OIDC workflow', () => {
  it('uses short-lived OIDC with read-only repository permissions', () => {
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('api%3A%2F%2FAzureADTokenExchange');
    expect(workflow).not.toContain('azure/login@');
  });

  it('uses repository variables instead of Microsoft client secrets', () => {
    for (const variable of [
      'ENTRA_TENANT_ID',
      'ENTRA_OPERATIONS_CLIENT_ID',
      'WEB_APPLICATION_OBJECT_ID',
      'GRAPH_APPLICATION_OBJECT_ID',
    ]) {
      expect(workflow).toContain(`vars.${variable}`);
    }
    expect(workflow).not.toContain('AZURE_CLIENT_SECRET');
    expect(workflow).not.toMatch(/secrets\.(ENTRA|AZURE|GRAPH|WEB)/u);
  });

  it('runs the real audit only from trusted main on dispatch, audited pushes or schedule', () => {
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain("github.event_name == 'push'");
    expect(workflow).toContain("github.event_name == 'schedule'");
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain("cron: '15 10 * * *'");
    expect(workflow).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(workflow).toContain('ACTIONS_ID_TOKEN_REQUEST_URL');
    expect(workflow).toContain(
      'client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    expect(workflow).toContain('https://graph.microsoft.com/.default');
    expect(workflow).toContain('scripts/entra/operations-audit.ts');
  });

  it('starts the audit CLI under Node strip-only TypeScript without unsupported syntax', () => {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', 'scripts/entra/operations-audit.ts'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GRAPH_ACCESS_TOKEN: '',
          WEB_APPLICATION_OBJECT_ID: '',
          GRAPH_APPLICATION_OBJECT_ID: '',
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Entra operations audit failed at missing-access-token');
    expect(result.stderr).not.toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
  });

  it('publishes only a count for Operations permissions while the detailed assignments stay runner-local', () => {
    expect(workflow).toContain('.operationsIdentity.appRoleAssignments | length');
    expect(workflow).not.toContain('.operationsIdentity.appRoleAssignments[]');
    expect(workflow).not.toContain('appRoleId +');
  });

  it('keeps SharePoint selected-site auditing disabled until the explicit repository variable is enabled', () => {
    expect(workflow).toContain('vars.ENTRA_SHAREPOINT_AUDIT_ENABLED');
    expect(workflow).toContain('.sharePoint.status | IN("disabled", "ok")');
    expect(workflow).toContain('isolation probe:');
  });

  it('fails closed on critical Entra drift while keeping the summary sanitized', () => {
    expect(workflow).toContain('.drift.status != "critical"');
    expect(workflow).toContain('Critical Entra configuration drift detected.');
    expect(workflow).toContain('"- Drift: "');
    expect(workflow).not.toContain('appRoleAssignments | @json');
  });

  it('does not publish detailed Entra metadata from the public repository', () => {
    expect(workflow).not.toContain('actions/upload-artifact');
    expect(workflow).toContain("trap 'rm -f");
    expect(workflow).toContain('GITHUB_STEP_SUMMARY');
  });
});

// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
function source(path: string): string { return readFileSync(join(root, path), 'utf8'); }

describe('Cloudflare Workers Paid runtime configuration', () => {
  it('pins the Pages Functions CPU safety envelope to 120 seconds', () => {
    const config = JSON.parse(source('wrangler.jsonc')) as {
      readonly limits?: { readonly cpu_ms?: unknown };
      readonly env?: { readonly production?: { readonly limits?: unknown } };
    };
    expect(config.limits).toEqual({ cpu_ms: 120_000 });
    expect(config.env?.production?.limits).toBeUndefined();
  });
  it('runs Pages Functions with Smart Placement without production overrides', () => {
    const config = JSON.parse(source('wrangler.jsonc')) as {
      readonly placement?: { readonly mode?: unknown };
      readonly env?: { readonly production?: { readonly placement?: unknown } };
    };
    expect(config.placement).toEqual({ mode: 'smart' });
    expect(config.env?.production?.placement).toBeUndefined();
  });
  it('deploys inherited settings without requiring, binding or deleting historical D1', () => {
    const config = source('wrangler.jsonc');
    const workflow = source('.github/workflows/deploy-cloudflare-pages.yml');
    expect(config).not.toContain('database_id');
    expect(config).not.toContain('GRADEBOOK_D1');
    expect(workflow).not.toContain('GRADEBOOK_D1_BINDING_CONFIG');
    expect(workflow).toContain('d1_databases: []');
    expect(workflow).toContain("config.vars?.GRADEBOOK_STORAGE_PROVIDER !== 'postgres'");
    expect(workflow).not.toMatch(/wrangler\s+d1\s+(delete|execute)/u);
    expect(workflow).toContain('config.env.production = {');
    expect(workflow).not.toContain('cpu_ms');
    expect(workflow).not.toContain('placement');
  });
  it('selects the dedicated Postgres Hyperdrive for official gradebook traffic', () => {
    const config = JSON.parse(source('wrangler.jsonc')) as {
      readonly vars?: { readonly GRADEBOOK_STORAGE_PROVIDER?: unknown };
      readonly hyperdrive?: readonly { readonly binding?: unknown; readonly id?: unknown }[];
    };
    expect(config.vars?.GRADEBOOK_STORAGE_PROVIDER).toBe('postgres');
    expect(config.hyperdrive?.filter(({ binding }) => binding === 'PROD_DB')).toEqual([
      { binding: 'PROD_DB', id: '476b417597c84b4c994bd36f1a65cb70' },
    ]);
    // Remote SQL cache is verified separately, not inferred from the binding ID.
  });
  it('uses only segmented tokens and the repository account variable in Cloudflare workflows', () => {
    const pagesWorkflow = source('.github/workflows/deploy-cloudflare-pages.yml');
    const portalWorkflow = source('.github/workflows/deploy-student-portal.yml');

    const accountIdExpression = '${{ vars.CLOUDFLARE_ACCOUNT_ID }}';
    expect(pagesWorkflow).toContain(`CLOUDFLARE_ACCOUNT_ID: ${accountIdExpression}`);
    expect(portalWorkflow).toContain(`CLOUDFLARE_ACCOUNT_ID: ${accountIdExpression}`);

    const deployTokenExpression = '${{ secrets.CLOUDFLARE_DEPLOY_TOKEN }}';
    expect(pagesWorkflow).toContain(`CLOUDFLARE_API_TOKEN: ${deployTokenExpression}`);
    expect(portalWorkflow).toContain(`CLOUDFLARE_API_TOKEN: ${deployTokenExpression}`);

    const hyperdriveTokenExpression = '${{ secrets.CLOUDFLARE_HYPERDRIVE_TOKEN }}';
    expect(pagesWorkflow).toContain(`CLOUDFLARE_API_TOKEN: ${hyperdriveTokenExpression}`);

    expect(pagesWorkflow).not.toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(pagesWorkflow).not.toContain('secrets.CLOUDFLARE_ACCOUNT_ID');
    expect(portalWorkflow).not.toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(portalWorkflow).not.toContain('secrets.CLOUDFLARE_ACCOUNT_ID');
  });
});

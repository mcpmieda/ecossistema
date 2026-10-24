// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createYearResetRequestHandlerV1 } from '../../../server/gradebook/http/year-reset-routes-v1';
import { requestYearResetV1 } from '../../../src/features/gradebook/settings/year-reset-client-v1';
import { seal } from '../../../server/auth/sealed';
import { SESSION_COOKIE } from '../../../server/auth/session';
import { testEnv } from '../../fixtures';
import type { RuntimeEnv } from '../../../server/env';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const unavailableDatabase = {
  transaction: async () => {
    throw new Error('synthetic-unavailable');
  },
  query: () => {
    throw new Error('outside-transaction');
  },
  executeNative: () => {
    throw new Error('outside-transaction');
  },
};

async function http(
  role: 'ADMINISTRADOR' | 'PROFESSOR' | null,
  overrides: Partial<RuntimeEnv> = {},
) {
  const headers = new Headers({
    Origin: testEnv.OFFICIAL_ORIGIN,
    'Content-Type': 'application/json',
  });
  if (role) {
    headers.set(
      'Cookie',
      `${SESSION_COOKIE}=${await seal(
        {
          oid: ACTOR,
          name: 'Synthetic',
          username: 'synthetic@example.test',
          roles: [role],
          exp: Math.floor(Date.now() / 1000) + 600,
        },
        testEnv.SESSION_SECRET,
      )}`,
    );
  }
  const response = await createYearResetRequestHandlerV1()(
    new Request(`${testEnv.OFFICIAL_ORIGIN}/api/gradebook/year-reset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ contractVersion: 1, operation: 'preview', year: 2025 }),
    }),
    {
      ...testEnv,
      RUNTIME_ENVIRONMENT: 'local',
      GRADEBOOK_STORAGE_PROVIDER: 'postgres',
      GRADEBOOK_DATABASE: unavailableDatabase,
      ...overrides,
    } as RuntimeEnv,
  );
  if (!response) throw new Error('route-not-found');
  return response;
}

describe('year reset V1 HTTP and UI boundary', () => {
  it('returns a private 409 for linked accounts and a 503 for a missing guard response', async () => {
    for (const state of ['portal-linked-accounts', null]) {
      const transaction = {
        executeNative: async () => ({ rows: [], changes: 0 }),
        query: async (sql: string) => sql.includes('AS state') && state !== null ? [{ state }] : [],
      };
      const response = await http('ADMINISTRADOR', {
        GRADEBOOK_DATABASE: {
          ...transaction,
          transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
            operation(transaction),
        },
      } as unknown as Partial<RuntimeEnv>);
      expect(response.status).toBe(state === null ? 503 : 409);
      expect(response.headers.get('Cache-Control')).toContain('no-store');
      expect(await response.json()).toEqual({ contractVersion: 1, state: state ?? 'unavailable' });
    }
  });

  it('is admin-only, no-store and fail-closed behind the PostgreSQL production gate', async () => {
    expect((await http(null)).status).toBe(401);
    expect((await http('PROFESSOR')).status).toBe(403);
    const allowed = await http('ADMINISTRADOR');
    expect(allowed.status).toBe(503);
    expect(allowed.headers.get('Cache-Control')).toContain('no-store');
    expect(await allowed.json()).toEqual({ contractVersion: 1, state: 'unavailable' });
    expect(
      (
        await http('ADMINISTRADOR', {
          RUNTIME_ENVIRONMENT: 'production',
          GRADEBOOK_PRODUCTION_ENABLED: 'false',
        })
      ).status,
    ).toBe(503);
  });

  it('validates requests and responses without trusting malformed network payloads', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      requestYearResetV1({
        contractVersion: 1,
        operation: 'execute',
        year: 2025,
        previewRevision: 'invalid',
        confirmationPhrase: 'RESETAR 2025',
        understandsIrreversible: true,
      }),
    ).resolves.toEqual({ contractVersion: 1, state: 'invalid-request' });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(Response.json({ contractVersion: 1, state: 'ready' }));
    await expect(
      requestYearResetV1({ contractVersion: 1, operation: 'preview', year: 2025 }),
    ).resolves.toEqual({ contractVersion: 1, state: 'unavailable' });
    vi.unstubAllGlobals();
  });

  it('mounts one current settings surface with guarded confirmation and Em curso wording', () => {
    const shell = source('src/platform/gradebook-workspace-shell.tsx');
    const notes = source('src/platform/notes-module.ts');
    const page = source('src/features/gradebook/settings/gradebook-settings-page-v1.tsx');
    const grid = source('src/features/gradebook/performance/performance-grid-v2.tsx');
    const functions = source('functions/[[path]].ts');
    expect(shell).toContain("id: 'settings'");
    expect(shell).toContain('GradebookSettingsPageV1');
    expect(notes).toContain("label: 'Configurações'");
    expect(page).toContain('preview.previewRevision');
    expect(page).toContain('understandsIrreversible: true');
    expect(page).toContain('confirmation !== preview.confirmationPhrase');
    expect(page).toContain('<Checkbox');
    expect(page).not.toContain('<input');
    // A student without a Smecel status reads as "Em curso" (statusShort in the grid).
    expect(grid).toMatch(/student\.status === null\) return 'Em curso'/u);
    expect(grid).not.toContain('Sem situação');
    expect(functions).toContain('handleYearResetRequestV1');
  });
});

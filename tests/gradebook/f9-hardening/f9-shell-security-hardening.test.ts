import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function sourceFiles(path: string): string[] {
  const absolute = join(root, path);
  return readdirSync(absolute).flatMap((entry) => {
    const child = join(absolute, entry);
    if (statSync(child).isDirectory()) return sourceFiles(join(path, entry));
    return /\.(?:ts|tsx)$/u.test(entry) ? [join(path, entry)] : [];
  });
}

const surfaceRoots = [
  'src/features/gradebook/operational-workspace',
  'src/features/gradebook/audit-workspace',
  'src/features/gradebook/performance',
  'src/features/gradebook/bulletins',
  'src/features/gradebook/council',
] as const;

const academicFrontendFiles = surfaceRoots.flatMap(sourceFiles);
const academicFrontend = academicFrontendFiles.map(source).join('\n');

const handlers = [
  'server/gradebook/http/operational-workspace-routes-v1.ts',
  'server/gradebook/http/performance-routes-v1.ts',
  'server/gradebook/http/bulletin-routes-v1.ts',
  'server/gradebook/http/council-routes-v1.ts',
] as const;

describe('F9 — shell, isolamento e code splitting', () => {
  it('mantém o Banco fora do chunk global e F4–F8 fora do chunk da entrada do Banco', () => {
    const app = source('src/App.tsx');
    const notesPage = source('src/platform/notes-page.tsx');
    const workspacePage = source('src/platform/gradebook-workspace-page.tsx');
    const shell = source('src/platform/gradebook-workspace-shell.tsx');

    expect(notesPage).toContain("import('./gradebook-workspace-page')");
    expect(workspacePage).toContain('<GradebookWorkspaceShell />');
    expect(notesPage).not.toContain('gradebook-workspace-shell');
    expect(notesPage).not.toContain('../features/gradebook/import/import-batch');
    for (const featurePath of [
      'audit-workspace/gradebook-audit-surface',
      'performance/relational-performance-page-v2',
      'bulletins/bulletin-page',
      'gradebook-council-surface',
    ]) {
      expect(shell).toContain(`import('${featurePath.startsWith('gradebook-') ? `./${featurePath}` : `../features/gradebook/${featurePath}`}')`);
    }
    expect(shell).not.toContain('gradebook-operational-surface');

    expect(app).not.toMatch(/features\/gradebook\/(?:operational-workspace|audit-workspace|performance|bulletins|council)/u);
    expect(shell).toContain("const DEFAULT_SURFACE: GradebookWorkspaceSurfaceId = 'importacao'");
    expect(shell).toContain('workspaceSurfaceFromHash()');
    expect(shell).toContain('new Set([workspaceSurfaceFromHash()])');
    expect(shell).toContain('if (!visitedSurfaces.has(surface.id)) return null');
    expect(shell).not.toMatch(/prefetch|Promise\.all|import\.meta\.glob/u);
  });

  it('mantém estado efêmero de áreas visitadas sem deixá-las no fluxo de foco quando inativas', () => {
    const shell = source('src/platform/gradebook-workspace-shell.tsx');

    expect(shell).toContain('visitedSurfaces');
    expect(shell).toContain('hidden={!active}');
    expect(shell).toContain('role="tablist"');
    expect(shell).toContain('role="tab"');
    expect(shell).toContain("role={surface.id === 'importacao' ? undefined : 'tabpanel'}");
    expect(shell).toContain("activeSurface !== 'importacao'");
    expect(shell).toContain('tabIndex={selected ? 0 : -1}');
    expect(shell).toContain("event.key !== 'ArrowLeft'");
    expect(shell).toContain("event.key === 'ArrowRight'");
    expect(shell).toContain("event.key === 'Home'");
    expect(shell).toContain("event.key === 'End'");
    expect(shell).toContain('aria-live="polite"');
    expect(shell).toContain('aria-busy="true"');
    expect(shell).toContain('overflow-x-auto');
  });

  it('isola falha de carregamento/renderização sem logar erro bruto nem prender spinner global', () => {
    const notesPage = source('src/platform/notes-page.tsx');
    const shell = source('src/platform/gradebook-workspace-shell.tsx');

    expect(notesPage).toContain('class GradebookRouteBoundary');
    expect(notesPage).toContain('O carregamento desta área falhou isoladamente. O restante do Centro continua disponível.');
    expect(notesPage).not.toMatch(/console\.(?:log|error|warn|debug)/u);
    expect(shell).toContain('class GradebookSurfaceBoundary');
    expect(shell).toContain('Esta experiência falhou isoladamente. As demais áreas do Banco continuam disponíveis.');
    expect(shell).toContain('Voltar à Importação');
    expect(shell).not.toMatch(/console\.(?:log|error|warn|debug)/u);
    expect(source('src/App.tsx')).not.toContain('aria-busy={');
  });

  it('preserva reduced motion global e navegação utilizável em viewport estreito/zoom', () => {
    const styles = source('src/styles.css');
    const shell = source('src/platform/gradebook-workspace-shell.tsx');

    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(shell).toContain('max-w-full');
    expect(shell).toContain('overflow-x-auto');
    expect(shell).toContain('min-w-0');
    expect(shell).not.toContain('min-w-[1024px]');
  });
});

describe('F9 — privacidade, auth e transporte', () => {
  it('proíbe storage acadêmico persistente e service worker/cache nos consumidores acadêmicos', () => {
    expect(academicFrontend).not.toMatch(
      /localStorage|sessionStorage|indexedDB|IDBDatabase|CacheStorage|caches\.open|navigator\.serviceWorker|serviceWorker\.register/u,
    );
  });

  it('mantém fetch acadêmico no-store em todo cliente dos consumidores acadêmicos', () => {
    const clients = academicFrontendFiles.filter((path) => {
      const content = source(path);
      return content.includes('/api/gradebook/') && content.includes('fetch(');
    });

    expect(clients.length).toBeGreaterThanOrEqual(5);
    for (const path of clients) {
      expect(source(path), path).toContain("cache: 'no-store'");
    }
  });

  it('mantém os quatro handlers dedicados restantes com auth opaca, origin gates e headers anti-cache completos', () => {
    for (const path of handlers) {
      const handler = source(path);
      expect(handler, path).toContain('requireAuth');
      expect(handler, path).toContain('authorizeGradebookRuntimeV1');
      expect(handler, path).toContain('enforceOfficialOrigin');
      expect(handler, path).toContain('enforceWriteOrigin');
      expect(handler, path).toContain("'Cache-Control': 'no-store, no-cache, must-revalidate, private'");
      expect(handler, path).toContain("Expires: '0'");
      expect(handler, path).toContain("Pragma: 'no-cache'");
      expect(handler, path).not.toMatch(/console\.(?:log|error|warn|debug)|cause\.message|String\(cause\)/u);
    }
  });

  it('mantém PostgreSQL lazy e não expõe o binding legado em nenhum ambiente', () => {
    const runtime = source('server/gradebook/persistence/postgres/official-gradebook-database-v1.ts');
    const providerGate = runtime.indexOf("if (!configured) throw new Error('gradebook-official-postgres-provider-required')");
    const bindingAccess = runtime.indexOf('return create(requireHyperdriveConnectionString(env))');

    expect(runtime).toContain('const database = lazyGradebookDatabaseV1(async () =>');
    expect(runtime).toContain('Object.getOwnPropertyDescriptors(env)');
    expect(runtime).toContain('GRADEBOOK_D1: { value: undefined');
    expect(providerGate).toBeGreaterThanOrEqual(0);
    expect(bindingAccess).toBeGreaterThan(providerGate);
  });

  it('não introduz retry automático de decisão do Conselho nem emissão de Boletim', () => {
    const council = source('src/features/gradebook/council/relational-council-page-v3.tsx');
    const bulletins = source('src/features/gradebook/bulletins/bulletin-page.tsx');

    expect(council).not.toMatch(/setInterval|retryDecision|retryEmit|autoRetry/u);
    expect(bulletins).not.toMatch(/setInterval|retryEmit|autoRetry/u);
  });
});

import { describe, expect, it } from 'vitest';
import {
  PLATFORM_CAPABILITIES,
  PLATFORM_ROUTES,
  normalizePlatformRoute,
} from '../shared/platform-contract';
import { capabilityGrantsByRole } from '../server/auth/capabilities';
import { coreModuleSchema, coreModules } from '../server/platform/manifest';
import { withNotesAccessV1 } from '../src/platform/notes-module';

const navigableModules = withNotesAccessV1(coreModules, capabilityGrantsByRole.ADMINISTRADOR);

describe('Centro de Administração module contract', () => {
  it('declares one stable navigable module per platform route', () => {
    expect(navigableModules).toHaveLength(PLATFORM_ROUTES.length);
    expect(new Set(navigableModules.map((module) => module.id)).size).toBe(navigableModules.length);
    expect(new Set(navigableModules.map((module) => module.route))).toEqual(
      new Set(PLATFORM_ROUTES),
    );
  });

  it('keeps the production platform restricted to administrators', () => {
    expect(navigableModules.every((module) => module.requiredRole === 'ADMINISTRADOR')).toBe(true);
  });

  it('requires explicit capabilities in every server module manifest', () => {
    expect(coreModules.every((module) => module.capabilities.length > 0)).toBe(true);
    for (const module of coreModules) expect(coreModuleSchema.parse(module)).toEqual(module);
  });

  it('reserves gradebook persistence administration for administrators', () => {
    expect(PLATFORM_CAPABILITIES).toContain('gradebook.persistence.admin');
    expect(capabilityGrantsByRole.ADMINISTRADOR).toContain('gradebook.persistence.admin');
    for (const role of ['PROFESSOR', 'ALUNO', 'APOIO', 'VISITANTE'] as const) {
      expect(capabilityGrantsByRole[role]).not.toContain('gradebook.persistence.admin');
    }
  });

  it('keeps the released administrative core ready, with no placeholder or catalogue area', () => {
    const states = new Map(navigableModules.map((module) => [module.route, module.state]));
    // Publicações, Páginas and Sistemas left the Centro on 07/10/2026 (owner request).
    const routes = navigableModules.map((module): string => module.route);
    for (const removed of ['publicacoes', 'paginas', 'sistemas'])
      expect(routes).not.toContain(removed);
    // Visão geral left on 08/10/2026 and Auditoria became a section of Saúde do Sistema.
    for (const removed of ['visao-geral', 'auditoria']) expect(routes).not.toContain(removed);
    expect(navigableModules.every((module) => module.state === 'ready')).toBe(true);
    expect(states.get('operacao')).toBe('ready');
    expect(states.get('configuracoes')).toBe('ready');
    expect(states.get('banco-de-notas')).toBe('ready');
  });

  it('gives the operational area its own area capability (#1513)', () => {
    const operation = coreModules.find((module) => module.route === 'operacao');
    expect(operation?.capabilities).toEqual(['area.saude']);
  });

  it('restores known routes, accepts scoped hash query data and falls back safely', () => {
    expect(normalizePlatformRoute('operacao')).toBe('operacao');
    expect(normalizePlatformRoute('auditoria')).toBe('banco-de-notas');
    expect(normalizePlatformRoute('banco-de-notas')).toBe('banco-de-notas');
    expect(normalizePlatformRoute('banco-de-notas?area=council')).toBe('banco-de-notas');
    expect(normalizePlatformRoute('banco-de-notas#council')).toBe('banco-de-notas');
    expect(normalizePlatformRoute('rota-inexistente?area=council')).toBe('banco-de-notas');
  });
});

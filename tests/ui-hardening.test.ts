import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

describe('HeroUI final hardening contract', () => {
  it('uses the native HeroUI SearchField composition in the header on desktop and mobile', () => {
    const search = source('src/platform/search.tsx');

    expect(search).toContain('<SearchField');
    expect(search).toContain('<Label className="sr-only">Buscar no Centro</Label>');
    expect(search).toContain('<SearchField.Group>');
    expect(search).toContain('<SearchField.SearchIcon />');
    expect(search).toContain('<SearchField.Input');
    expect(search).toContain('<SearchField.ClearButton />');
    expect(search).toContain('<Kbd.Content>Ctrl K</Kbd.Content>');
    expect(search).toContain('platform-search-mobile-panel');
    expect(search).not.toContain('platform-search-field');
    expect(search).not.toMatch(/\bDrawer\b/u);
    expect(search).not.toMatch(/\bPopover\b/u);
    expect(search).not.toContain('hashchange');
  });

  it('uses native HeroUI Avatar composition and keeps profile menu content separated', () => {
    const app = source('src/App.tsx');

    expect(app).toMatch(/<Dropdown>\s*<Button[\s\S]*?aria-label="Abrir menu do perfil"/u);
    expect(app).not.toContain('<Dropdown.Trigger>');
    expect(app).toContain('<Avatar');
    expect(app).toContain('<Avatar.Fallback');
    expect(app).toContain('profile-menu-item-content');
    expect(app).toContain('profile-menu-copy');
    expect(app).toContain('<Dropdown.Item id="logout"');
    expect(app).toContain('Não foi possível concluir sua entrada.');
    expect(app).toContain('Entrar novamente');
    expect(app).toContain('<ShellSidebarV3');
    // The old top menu and section row are gone, not hidden: nothing of them is mounted.
    expect(app).not.toContain('TopNavigationV2');
    expect(app).not.toContain('ServiceSidebarV2');
  });

  it('removes Ambient Constellation and all active ambient presentation hooks', () => {
    const presentation = [
      source('src/App.tsx'),
      source('src/platform/navigation.tsx'),
      source('src/platform/pages.tsx'),
      source('src/platform/presentation.tsx'),
      source('src/styles.css'),
    ].join('\n');

    expect(existsSync(join(root, 'src/components/ambient-constellation.tsx'))).toBe(false);
    expect(existsSync(join(root, 'src/components/ambient-constellation.css'))).toBe(false);
    expect(presentation).not.toMatch(
      /AmbientConstellation|ambient-constellation|pro-spectrum|living-aura|living-surface|living-page-header/u,
    );
    expect(presentation).not.toMatch(/#cce5f1|#e8f3ff|#5dd0e7|#4a8dff/iu);
  });

  it('keeps the requested neutral page background and removes the visible v1 badge', () => {
    const styles = source('src/styles.css');
    const navigation = source('src/platform/navigation.tsx');

    expect(styles).toContain('--platform-page-background: #f4f4f5;');
    expect(styles).toContain('background: #f4f4f5;');
    expect(navigation).not.toMatch(/>\s*v1\s*</u);
    // One compact top row since the shell of 07/10/2026.
    expect(styles).toContain('--shell-top: 3.25rem;');
    expect(source('src/App.tsx')).toContain('shell-topbar');
  });

  it('uses HeroUI table scroll containers for every structured table', () => {
    const tableSources = [
      source('src/platform/pages.tsx'),
      source('src/platform/system-health-page-v1.tsx'),
    ].join('\n');
    const tables = tableSources.match(/<Table variant=/gu) ?? [];
    const scrollContainers = tableSources.match(/<Table\.ScrollContainer>/gu) ?? [];

    expect(tables.length).toBeGreaterThan(0);
    expect(scrollContainers).toHaveLength(tables.length);
    expect(source('src/styles.css')).toContain('.table__scroll-container');
  });

  it('does not reintroduce legacy visual compatibility patterns', () => {
    const presentation = [
      source('src/App.tsx'),
      source('src/platform/search.tsx'),
      source('src/platform/navigation.tsx'),
      source('src/platform/pages.tsx'),
      source('src/platform/presentation.tsx'),
    ].join('\n');

    expect(presentation).not.toMatch(/components\/ui|@radix-ui|shadcn|reui/iu);
    expect(presentation).not.toMatch(/<kbd\b/u);
    expect(presentation).not.toContain('window.location.assign(item.href)');
  });
});

// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const css = readFileSync('src/features/student-portal/workspace/student-workspace-v1.css', 'utf8');

it('contains nested HeroUI subject and period tabs on mobile instead of widening the page', () => {
  expect(css).toContain(".pa-student-workspace .tabs[data-orientation='horizontal']");
  expect(css).toContain('> .tabs__list-container__scroller');
  expect(css).toMatch(
    />\s*\.tabs__list\[data-orientation='horizontal'\]\s*\{[^}]*width:\s*max-content/s,
  );
  expect(css).toMatch(
    />\s*\.tabs__tab\s*\{[^}]*width:\s*auto;[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap/s,
  );
  expect(css).toMatch(/\.pa-workspace-view\s*>\s*\*\s*\{[^}]*max-width:\s*100%/s);
  expect(css).toMatch(/\.pa-score-card\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0/s);
});

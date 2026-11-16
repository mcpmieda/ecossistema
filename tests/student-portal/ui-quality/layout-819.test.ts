// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const css = (path: string) => readFileSync(path, 'utf8');
it('prevents Card.Content defaults from turning horizontal filter widths into hundreds of pixels of row height', () => {
  const accounts = css('src/features/student-portal-admin/accounts/student-accounts-v1.css');
  expect(accounts).toMatch(
    /\.pa-accounts \.pa-account-controls\.card__content\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,/s,
  );
  expect(accounts).toMatch(
    /\.pa-account-filters\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,/s,
  );
  expect(accounts).toMatch(
    /\.pa-account-filters\s*>\s*\*\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s,
  );
  const operations = css('src/features/student-portal-admin/overview/student-operations-v1.css');
  expect(operations).toMatch(/\.pa-operations-filters\s*\{[^}]*flex-direction:\s*row/s);
});
it('sizes the dashboard from content width and targets the native tab scroller in both workspaces', () => {
  const admin = css('src/features/student-portal-admin/shared/admin-page-v1.css');
  const operations = css('src/features/student-portal-admin/overview/student-operations-v1.css');
  const tabs = css('src/shared/ui/workspace-tabs-v1.css');
  expect(admin).toContain('container-type: inline-size');
  expect(tabs).toContain('.pa-admin-page .tabs');
  expect(tabs).toContain('.performance-workspace .tabs');
  expect(tabs).toMatch(/\.tabs__list-container__scroller\s*>\s*\.tabs__list/u);
  expect(tabs).toMatch(/>\s*\.tabs__tab\s*\{[^}]*width:\s*auto/s);
  expect(operations).toContain('@container (min-width: 1280px)');
  expect(operations).not.toContain('@media (min-width: 1500px)');
});
it('keeps animation budgets short and honors reduced motion without removing native components', () => {
  const styles = css('src/styles.css');
  expect(styles).toContain('--drawer-enter-duration: 120ms');
  expect(styles).toContain('--drawer-exit-duration: 100ms');
  expect(styles).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  expect(styles).toContain('--drawer-enter-duration: 0ms');
});

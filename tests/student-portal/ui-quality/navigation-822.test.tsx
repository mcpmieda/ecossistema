// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import { Tabs } from '@heroui/react/tabs';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClassTabsV1 } from '../../../src/shared/ui/class-tabs-v1';
import { setupOperationsDomV1 } from '../ui/overview/dom-v1';

const items = Array.from({ length: 15 }, (_, index) => ({
  id: index + 1,
  label: `SYNTHETIC CLASS ${index + 1}`,
}));
let stylesheet: HTMLStyleElement;
beforeEach(() => {
  setupOperationsDomV1();
  stylesheet = document.createElement('style');
  // Reproduce the upstream full-width tab before applying the actual application rules.
  // This is a native DOM/selector regression, not a browser geometry measurement.
  stylesheet.textContent =
    '.tabs__tab { width: 100%; }\n' + readFileSync('src/shared/ui/workspace-tabs-v1.css', 'utf8');
  document.head.appendChild(stylesheet);
});
afterEach(() => {
  cleanup();
  stylesheet.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function Navigation({ surface }: { surface: string }) {
  const [area, setArea] = useState('overview');
  const [selected, setSelected] = useState<number | null>(1);
  return (
    <section className={surface}>
      <Tabs selectedKey={area} onSelectionChange={(key) => setArea(String(key))}>
        <Tabs.ListContainer>
          <Tabs.List aria-label="SYNTHETIC AREAS">
            <Tabs.Tab id="overview">
              Visão geral
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="accounts">
              Alunos
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="settings">
              Configurações
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id={area}>
          <ClassTabsV1 items={items} selectedId={selected} onChange={setSelected}>
            <output data-testid="context">
              {area}:{selected}
            </output>
            <Tabs defaultSelectedKey="notes">
              <Tabs.ListContainer>
                <Tabs.List aria-label="SYNTHETIC PERSPECTIVES">
                  <Tabs.Tab id="notes">
                    Notas
                    <Tabs.Indicator />
                  </Tabs.Tab>
                  <Tabs.Tab id="summary">
                    Resumo
                    <Tabs.Indicator />
                  </Tabs.Tab>
                </Tabs.List>
              </Tabs.ListContainer>
              <Tabs.Panel id="notes">SYNTHETIC NOTES</Tabs.Panel>
              <Tabs.Panel id="summary">SYNTHETIC SUMMARY</Tabs.Panel>
            </Tabs>
          </ClassTabsV1>
        </Tabs.Panel>
      </Tabs>
    </section>
  );
}
it.each(['pa-admin-page', 'performance-workspace'])(
  'matches the real HeroUI scroller and overrides full-width tabs in %s',
  (surface) => {
    render(<Navigation surface={surface} />);
    const lists = screen.getAllByRole('tablist');
    expect(lists).toHaveLength(3);
    expect(
      within(screen.getByRole('tablist', { name: 'Turmas' })).getAllByRole('tab'),
    ).toHaveLength(15);
    for (const list of lists) {
      const scroller = list.parentElement!;
      expect(scroller.classList.contains('tabs__list-container__scroller')).toBe(true);
      expect(scroller.parentElement!.classList.contains('tabs__list-container')).toBe(true);
      expect(getComputedStyle(scroller.parentElement!).width).toBe('fit-content');
      for (const tab of within(list).getAllByRole('tab'))
        expect(getComputedStyle(tab).width).toBe('auto');
    }
  },
);
it.each(['pa-admin-page', 'performance-workspace'])(
  'preserves manual keyboard activation and selected class across area changes in %s',
  async (surface) => {
    render(<Navigation surface={surface} />);
    const user = userEvent.setup();
    const classes = screen.getByRole('tablist', { name: 'Turmas' });
    await user.click(within(classes).getByRole('tab', { name: 'SYNTHETIC CLASS 2' }));
    expect(screen.getByTestId('context').textContent).toBe('overview:2');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByTestId('context').textContent).toBe('overview:2');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('context').textContent).toBe('overview:3');
    await user.click(
      within(screen.getByRole('tablist', { name: 'SYNTHETIC AREAS' })).getByRole('tab', {
        name: 'Alunos',
      }),
    );
    expect(screen.getByTestId('context').textContent).toBe('accounts:3');
    expect(
      screen.getByRole('tab', { name: 'SYNTHETIC CLASS 3' }).getAttribute('aria-selected'),
    ).toBe('true');
  },
);

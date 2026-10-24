import type { ReactNode } from 'react';
import { Tabs } from '@heroui/react/tabs';
import './workspace-tabs-v1.css';

/** Native HeroUI tabs. The selected panel owns its content; no extra class selector. */
export function ClassTabsV1({
  items,
  selectedId,
  onChange,
  children,
  allLabel,
  label = 'Turmas',
  disabled = false,
}: Readonly<{
  items: readonly { id: number; label: string }[];
  selectedId: number | null;
  onChange: (id: number | null) => void;
  children?: ReactNode;
  allLabel?: string;
  label?: string;
  disabled?: boolean;
}>) {
  const selected = selectedId === null ? 'all' : String(selectedId);
  return (
    <Tabs
      className="school-class-tabs"
      selectedKey={selected}
      keyboardActivation="manual"
      onSelectionChange={(key) => {
        if (disabled) return;
        if (key === 'all' && allLabel) onChange(null);
        else if (items.some((item) => String(item.id) === key)) onChange(Number(key));
      }}
    >
      <Tabs.ListContainer>
        <Tabs.List aria-label={label}>
          {allLabel ? (
            <Tabs.Tab id="all" isDisabled={disabled}>
              {allLabel}
              <Tabs.Indicator />
            </Tabs.Tab>
          ) : null}
          {items.map((item) => (
            <Tabs.Tab key={item.id} id={String(item.id)} isDisabled={disabled}>
              {item.label}
              <Tabs.Indicator />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs.ListContainer>
      <Tabs.Panel id={selected} className="school-class-content">
        {children}
      </Tabs.Panel>
    </Tabs>
  );
}

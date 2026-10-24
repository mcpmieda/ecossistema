import type { ReactNode } from 'react';
import { Tooltip } from '@heroui/react/tooltip';
import { Info } from 'lucide-react';

export function InfoV1({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <Tooltip delay={120} closeDelay={0}>
      <Tooltip.Trigger aria-label={label} tabIndex={0} className="pa-info">
        <Info size={15} aria-hidden="true" />
      </Tooltip.Trigger>
      <Tooltip.Content className="max-w-80 text-sm">{children}</Tooltip.Content>
    </Tooltip>
  );
}

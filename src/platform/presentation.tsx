import { Chip, Surface } from '@heroui/react';
import { Boxes, type LucideIcon } from 'lucide-react';

export { BrandMark } from '../lib/brand-mark';

export function EmptyState({
  icon: Icon = Boxes,
  title,
  description,
}: Readonly<{
  icon?: LucideIcon;
  title: string;
  description: string;
}>) {
  return (
    <Surface
      variant="transparent"
      className="platform-empty-state flex flex-col items-center justify-center px-5 py-12 text-center"
    >
      <div className="platform-icon">
        <Icon className="size-4 text-accent" />
      </div>
      <Chip color="accent" variant="soft" size="sm" className="mt-5">
        Estado disponível
      </Chip>
      <h3 className="mt-4 text-base font-semibold tracking-[-0.02em]">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted">{description}</p>
    </Surface>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  titleInBar = false,
}: Readonly<{
  eyebrow: string;
  title: string;
  description: string;
  /** The top bar already shows this title: it stays for assistive technology only. */
  titleInBar?: boolean;
}>) {
  return (
    <Surface variant="default" className="platform-page-header">
      <div className="platform-page-header__content">
        <Chip color="accent" variant="soft" size="sm">
          {eyebrow}
        </Chip>
        <h2
          className={
            titleInBar ? 'sr-only' : 'mt-4 text-2xl font-semibold tracking-[-0.045em] sm:text-3xl'
          }
        >
          {title}
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{description}</p>
      </div>
    </Surface>
  );
}

export function formatDate(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

export function shortCorrelation(value: string): string {
  return value ? `${value.slice(0, 8)}…` : '—';
}

export function initials(value?: string): string {
  if (!value?.trim()) return 'AD';
  return value
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');
}

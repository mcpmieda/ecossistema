import { Chip } from '@heroui/react/chip';

/** Presentation only. Missing evidence must not be passed as notDone. */
export function GranularStatusV1({
  notDone,
  zero,
}: Readonly<{ notDone?: boolean; zero: boolean }>) {
  if (!notDone && !zero) return null;
  return (
    <Chip size="sm" color={notDone ? 'warning' : 'danger'} variant="soft">
      <Chip.Label>{notDone ? 'Não fez' : 'Tirou zero'}</Chip.Label>
    </Chip>
  );
}

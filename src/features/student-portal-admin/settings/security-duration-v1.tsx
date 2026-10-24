import { Label, ListBox, Select } from '@heroui/react';
import type { RiskDraftV1 } from './settings-draft-v1';

export const RISK_HELP_V1: Record<keyof RiskDraftV1, string> = {
  persistentSeconds:
    'Duração máxima do acesso quando o aluno marca Permanecer conectado. Alterar este limite também pode encurtar sessões existentes.',
  shortSeconds:
    'Duração do acesso sem marcar Permanecer conectado. Não pode ser maior que o tempo acima.',
  challengeAfter:
    'Após este número de tentativas incorretas, o aluno precisa concluir uma verificação de segurança.',
  blockAfter:
    'Número de tentativas incorretas que gera um bloqueio temporário. Deve ser maior que o número para pedir verificação.',
  blockSeconds:
    'Quanto tempo o aluno aguarda para tentar novamente depois de atingir o limite de tentativas.',
  failureWindowSeconds:
    'Intervalo usado para somar tentativas incorretas. Tentativas anteriores a esse intervalo deixam de contar.',
  challengeTtlSeconds:
    'No primeiro acesso, tempo que o aluno tem para criar a senha depois de digitar o PIN.',
};
export function durationLabelV1(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'Não definido';
  const parts: string[] = [];
  let rest = seconds;
  for (const [size, label] of [
    [86400, 'dia'],
    [3600, 'h'],
    [60, 'min'],
    [1, 's'],
  ] as const) {
    const n = Math.floor(rest / size);
    if (n) {
      parts.push(`${n} ${label}${label === 'dia' && n !== 1 ? 's' : ''}`);
      rest -= n * size;
    }
  }
  return parts.join(' ') || '0 s';
}
/** Presets are seconds on the wire. An existing custom value is kept exactly, not rounded. */
export function DurationEditorV1({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: Readonly<{
  label: string;
  value: string;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (seconds: string) => void;
}>) {
  const presets = [
    30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400, 259200, 604800,
    1209600, 2592000, 7776000, 31536000,
  ];
  const current = Number(value);
  const options = [
    ...new Set([
      ...presets,
      ...(Number.isSafeInteger(current) && current >= min && current <= max ? [current] : []),
    ]),
  ]
    .filter((n) => n >= min && n <= max)
    .sort((a, b) => a - b);
  return (
    <Select
      selectedKey={options.includes(current) ? String(current) : null}
      isDisabled={disabled}
      onSelectionChange={(key) => {
        if (key !== null && options.includes(Number(key))) onChange(String(key));
      }}
    >
      <Label className="sr-only">{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((n) => (
            <ListBox.Item key={n} id={String(n)} textValue={durationLabelV1(n)}>
              {durationLabelV1(n)}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

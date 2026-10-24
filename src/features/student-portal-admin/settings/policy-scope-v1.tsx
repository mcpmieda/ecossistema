import type { ReactNode } from 'react';
import { Building2, Clock3, GraduationCap, UserRound } from 'lucide-react';
import { Chip } from '@heroui/react';
import type { PolicyScopeV1 as PolicyScopeValueV1 } from '../../../../shared/student-portal-contracts/core-v1';
export function PolicyScopeV1({
  scope,
  label,
  note,
}: Readonly<{
  scope: PolicyScopeValueV1;
  label?: string;
  /** A short warning about shift rules (owner decision 28/09/2026). */
  note?: ReactNode;
}>) {
  const Icon =
    scope.kind === 'school'
      ? Building2
      : scope.kind === 'class'
        ? GraduationCap
        : scope.kind === 'shift'
          ? Clock3
          : UserRound;
  return (
    <div
      className={'pa-policy-scope pa-policy-scope--' + scope.kind}
      role="note"
      aria-label="Alcance das políticas"
    >
      <Chip size="sm" variant="soft">
        <Icon size={15} aria-hidden />
        {scope.kind === 'school'
          ? 'Toda a escola'
          : scope.kind === 'class'
            ? 'Esta turma'
            : scope.kind === 'shift'
              ? 'Este turno'
              : 'Este aluno'}
      </Chip>
      {scope.kind !== 'school' && label ? <strong>{label}</strong> : null}
      <span>
        {scope.kind === 'school'
          ? 'Padrão para turnos, turmas e alunos'
          : 'As opções sem personalização seguem o padrão.'}
      </span>
      {note ? <div className="pa-policy-scope-note">{note}</div> : null}
    </div>
  );
}

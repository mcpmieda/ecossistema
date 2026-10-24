/// <reference lib="dom" />

import {
  relationalBulletinSnapshotSchemaV2,
  type RelationalBulletinSnapshotV2,
} from '../../../../../shared/gradebook-contracts/bulletins/relational-bulletin-v2';
import {
  BULLETIN_PDF_LIMITS_V1,
  BulletinPdfRendererErrorV1,
  renderBulletinPdfLinesV1,
  type BulletinPdfArtifactV1,
  type BulletinPdfLineV1,
} from './bulletin-pdf-renderer-v1';

export type RelationalBulletinPdfReadinessV2 =
  | { readonly status: 'ready' }
  | { readonly status: 'invalid-input' | 'bounds-exceeded'; readonly reason: string };

function clean(value: string): string {
  return Array.from(value.normalize('NFC'), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

function grade(value: number | null): string {
  return value === null
    ? '—'
    : (value / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

function period(snapshot: RelationalBulletinSnapshotV2): string {
  return snapshot.model.period.kind === 'annual'
    ? 'ANUAL + RECUPERAÇÃO'
    : `${snapshot.model.period.term}º TRIMESTRE`;
}

function comparison(value: 'match' | 'mismatch' | 'unavailable'): string {
  if (value === 'match') {
    return 'CONFERE';
  }
  if (value === 'mismatch') {
    return 'DIVERGE';
  }
  return 'SEM COMPARAÇÃO';
}

function classification(
  value: NonNullable<
    RelationalBulletinSnapshotV2['model']['subjects'][number]['annual']
  >['classification'],
): string {
  const labels = {
    'in-progress': 'EM CURSO',
    'approved-direct': 'APROVADO DIRETO',
    'recovery-pending': 'RECUPERAÇÃO PENDENTE',
    'approved-after-recovery': 'APROVADO PELA RECUPERAÇÃO',
    'not-approved': 'NÃO APROVADO',
    'failed-no-show': 'REPROVADO POR NÃO COMPARECIMENTO',
    'failed-repeat': 'REPROVADO',
  } as const;
  return labels[value];
}

function text(
  lines: BulletinPdfLineV1[],
  role: Extract<BulletinPdfLineV1, { readonly kind: 'text' }>['role'],
  value: string,
  indent = 0,
): void {
  lines.push({
    kind: 'text',
    role,
    text: clean(value),
    ...(indent === 0 ? {} : { indent }),
  });
}

function recoveryGrade(value: number | 'NC' | 'RR' | null): string {
  if (value === 'NC') return 'N/C';
  if (value === 'RR') return 'R/R';
  return grade(value);
}

export function inspectRelationalBulletinPdfV2(
  snapshot: RelationalBulletinSnapshotV2,
): RelationalBulletinPdfReadinessV2 {
  const parsed = relationalBulletinSnapshotSchemaV2.safeParse(snapshot);
  if (!parsed.success) return { status: 'invalid-input', reason: 'canonical-snapshot-required' };
  const instruments = snapshot.model.subjects.reduce(
    (total, subject) =>
      total + subject.terms.reduce((termTotal, term) => termTotal + term.instruments.length, 0),
    0,
  );
  if (snapshot.model.subjects.length > BULLETIN_PDF_LIMITS_V1.maxSubjects) {
    return { status: 'bounds-exceeded', reason: 'subject-limit' };
  }
  if (instruments > BULLETIN_PDF_LIMITS_V1.maxAssessments) {
    return { status: 'bounds-exceeded', reason: 'assessment-limit' };
  }
  if (JSON.stringify(snapshot.model).length > BULLETIN_PDF_LIMITS_V1.maxTextCharacters) {
    return { status: 'bounds-exceeded', reason: 'text-limit' };
  }
  return { status: 'ready' };
}

function assertReady(snapshot: RelationalBulletinSnapshotV2): void {
  const readiness = inspectRelationalBulletinPdfV2(snapshot);
  if (readiness.status === 'ready') return;
  throw new BulletinPdfRendererErrorV1(readiness.status, readiness.reason);
}

/** Presentation-only projection. Academic values are copied from the immutable V2 snapshot. */
export function buildRelationalBulletinPdfLinesV2(
  snapshot: RelationalBulletinSnapshotV2,
): readonly BulletinPdfLineV1[] {
  assertReady(snapshot);
  const { model } = snapshot;
  const lines: BulletinPdfLineV1[] = [];
  text(lines, 'title', 'BOLETIM ESCOLAR');
  text(lines, 'meta', `Aluno: ${model.student.name}`);
  text(lines, 'meta', `Turma: ${model.classGroup.name} · ${model.classGroup.code}`);
  text(lines, 'meta', `Número: ${model.student.number} · Situação: ${model.student.statusLabel}`);
  text(lines, 'meta', `Período: ${period(snapshot)}`);
  text(
    lines,
    'meta',
    `Snapshot: ${snapshot.snapshotId} · versão ${snapshot.snapshotVersion} · modelo ${model.modelVersion}`,
  );
  text(
    lines,
    'meta',
    `Emitido em: ${new Date(snapshot.emittedAt).toLocaleString(snapshot.presentation.locale)}`,
  );
  text(
    lines,
    'meta',
    'Autoridade: AM/U importadas são oficiais; cálculo nativo é comparação descritiva.',
  );
  lines.push({ kind: 'space', height: 16 }, { kind: 'rule' }, { kind: 'space', height: 16 });

  for (const subject of model.subjects) {
    text(
      lines,
      'section',
      `${subject.subject.abbreviation ? `${subject.subject.abbreviation} · ` : ''}${subject.subject.label}`,
    );
    text(lines, 'meta', `Professor: ${subject.teacher.label}`, 20);
    for (const term of subject.terms) {
      text(lines, 'subsection', `${term.term}º TRIMESTRE`);
      text(
        lines,
        'body',
        `AM oficial: ${grade(term.sourceAmMilli)} · cálculo comparativo: ${grade(term.calculatedAmMilli)} · ${comparison(term.comparison)}`,
        20,
      );
      text(
        lines,
        'body',
        `Composição calculada: quantitativo original ${grade(term.quantitative.originalMilli)} · recuperação paralela ${grade(term.quantitative.parallelMilli)} · quantitativo considerado ${grade(term.quantitative.consideredMilli)} · qualitativo ${grade(term.qualitativeMilli)}`,
        20,
      );
      text(
        lines,
        'meta',
        `Cobertura: ${term.coverage.missingSlots.length === 0 ? 'COMPLETA' : 'PARCIAL'} · slots resolvidos ${term.coverage.resolvedSlots.length}/${term.coverage.requiredSlots.length}`,
        20,
      );
      if (model.detail === 'detailed') {
        for (const instrument of term.instruments) {
          text(
            lines,
            'meta',
            `${instrument.label} · ${instrument.notDone ? 'Não fez' : instrument.valueMilli === 0 ? 'Tirou zero' : 'nota ' + grade(instrument.valueMilli)} / ${grade(instrument.maximumMilli)}`,
            36,
          );
        }
      }
    }
    if (subject.annual) {
      text(lines, 'subsection', 'RESULTADO ANUAL');
      text(
        lines,
        'body',
        `Total normal calculado: ${grade(subject.annual.originalTotalMilli)} · U oficial: ${grade(subject.annual.sourceUMilli)} · cálculo pós-REC: ${grade(subject.annual.calculatedPostRecoveryMilli)}`,
        20,
      );
      text(
        lines,
        'body',
        `REC: ${subject.annual.recoveryTerms
          .map((recovery) =>
            recovery.applicable
              ? `${recovery.term}º ${recoveryGrade(recovery.source)}`
              : `${recovery.term}º —`,
          )
          .join(' · ')}`,
        20,
      );
      text(
        lines,
        'body',
        `Situação do componente: ${classification(subject.annual.classification)}`,
        20,
      );
    }
    lines.push({ kind: 'space', height: 12 }, { kind: 'rule' }, { kind: 'space', height: 12 });
  }

  text(lines, 'section', 'RESULTADO GERAL');
  text(lines, 'body', model.overall.visibleResult ?? 'SEM RESULTADO GERAL');
  if (model.overall.formalCouncilDecision) {
    text(lines, 'meta', `Decisão formal registrada: ${model.overall.formalCouncilDecision}`);
  }
  if (model.student.statusLabel === 'ASSISTIDO') {
    text(lines, 'meta', 'ASSISTIDO: notas exibidas sem resultado geral.');
  }
  return lines;
}

export async function renderRelationalBulletinPdfV2(
  snapshot: RelationalBulletinSnapshotV2,
): Promise<BulletinPdfArtifactV1> {
  return renderBulletinPdfLinesV1(
    buildRelationalBulletinPdfLinesV2(snapshot),
    snapshot.snapshotVersion,
  );
}

import {
  type GradebookImportDiagnosticAuditItemV1,
  type GradebookImportDiagnosticCodeV1,
  type GradebookImportDiagnosticFieldKindV1,
  type GradebookImportDiagnosticSeverityV1,
  type GradebookImportDiagnosticsAuditRequestV1, GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1 
} from '../../../../shared/gradebook-contracts/imports/import-diagnostics-v1';

import { SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2 } from '../../../../shared/gradebook-contracts/source/source-contract-v2';
import type { GradebookImportResultCellObservationV4 } from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v4';
import type { BatchSuccess } from './import-batch';
import type {
  GradeSheetRecognition,
  StudentRecognition,
  WorkbookSummary,
} from './spreadsheet-recognizer';
import type { MasterRelationRecognitionV9 } from './master-relation-v9';
import { scalarTextV1 } from '../../../../shared/scalar-text-v1';

export interface GradebookImportDiagnosticV1 extends GradebookImportDiagnosticAuditItemV1 {
  readonly studentName?: string;
}

type SummaryWithRelationV9 = WorkbookSummary & {
  readonly masterRelationV9?: MasterRelationRecognitionV9;
};

type DiagnosticBase = {
  readonly severity: GradebookImportDiagnosticSeverityV1;
  readonly code: GradebookImportDiagnosticCodeV1;
  readonly message: string;
  readonly recommendedAction: string;
  readonly classCode?: string;
  readonly subject?: string;
  readonly period?: string;
  readonly studentNumber?: number;
  readonly studentName?: string;
  readonly fieldKind: GradebookImportDiagnosticFieldKindV1;
  readonly slot?: number;
  readonly fieldLabel?: string;
  readonly foundValue?: string;
  readonly cause?: string;
  readonly sheetName?: string;
  readonly cellAddress?: string;
};

function periodLabel(sheet: GradeSheetRecognition): string {
  switch (sheet.stage) {
    case 'trimester-1':
      return '1º trimestre';
    case 'trimester-2':
      return '2º trimestre';
    case 'trimester-3':
      return '3º trimestre';
    case 'recovery':
      return 'Recuperação final';
    case 'overview':
      return 'Visão geral';
  }
}

function stableKey(value: DiagnosticBase): string {
  return [
    value.code,
    value.classCode ?? '',
    value.subject ?? '',
    value.period ?? '',
    value.studentNumber ?? '',
    value.fieldKind,
    value.slot ?? '',
    value.sheetName ?? '',
    value.cellAddress ?? '',
  ]
    .join('|')
    .slice(0, 320);
}

function diagnostic(value: DiagnosticBase): GradebookImportDiagnosticV1 {
  return { ...value, key: stableKey(value) };
}

function studentNumber(student: StudentRecognition): number | undefined {
  const value = Number(student.number.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function snapshot(sheet: GradeSheetRecognition, address: string): unknown {
  return sheet.snapshotCellsV8?.[address];
}

function displayValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return undefined;
  return scalarTextV1(value).trim().slice(0, 240) || undefined;
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[+-]?\d+(?:[.,]\d+)?$/u.test(trimmed)) return null;
  const parsed = Number(trimmed.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function isNcText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toUpperCase().replaceAll('/', '') === 'NC';
}

function isRrText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toUpperCase().replaceAll('/', '') === 'RR';
}

function hasExactThousandths(value: number): boolean {
  const scaled = value * 1000;
  return Number.isSafeInteger(Math.round(scaled)) && Math.abs(scaled - Math.round(scaled)) <= 1e-7;
}

function unavailableCause(observation?: GradebookImportResultCellObservationV4): string {
  if (observation?.classification === 'formula-error-or-missing-cache') {
    if (observation.sourceError) {
      return `Erro salvo pela planilha: ${String(observation.sourceError).slice(0, 200)}`;
    }
    return 'A fórmula não possui resultado calculado salvo no arquivo.';
  }
  return 'A origem está marcada como erro ou fórmula sem resultado utilizável salvo.';
}

function inspectCell(input: {
  readonly sheet: GradeSheetRecognition;
  readonly student: StudentRecognition;
  readonly address: string;
  readonly fieldKind: GradebookImportDiagnosticFieldKindV1;
  readonly fieldLabel: string;
  readonly slot?: number;
  readonly maximum?: number | null;
  readonly allowRecoveryMarkers?: boolean;
  readonly observation?: GradebookImportResultCellObservationV4;
}): readonly GradebookImportDiagnosticV1[] {
  const raw = snapshot(input.sheet, input.address);
  const base = {
    classCode: input.sheet.className.trim().toUpperCase(),
    subject: input.sheet.discipline.trim() || undefined,
    period: periodLabel(input.sheet),
    studentNumber: studentNumber(input.student),
    studentName: input.student.name.trim() || undefined,
    fieldKind: input.fieldKind,
    ...(input.slot === undefined ? {} : { slot: input.slot }),
    fieldLabel: input.fieldLabel,
    sheetName: input.sheet.name,
    cellAddress: input.address,
  } as const;

  if (
    Array.isArray(raw) ||
    input.observation?.classification === 'formula-error-or-missing-cache'
  ) {
    return [
      diagnostic({
        ...base,
        severity: 'warning',
        code: 'source-unavailable',
        message: 'Um valor de origem está indisponível.',
        recommendedAction:
          'Recalcule e salve a planilha no Excel. Ao reimportar, o Banco usará o resultado salvo; nenhum zero é inventado.',
        cause: unavailableCause(input.observation),
      }),
    ];
  }

  if (raw === undefined || raw === null || raw === '') return [];
  if (input.allowRecoveryMarkers && (isNcText(raw) || isRrText(raw))) return [];

  const numeric = numericValue(raw);
  if (numeric === null) {
    return [
      diagnostic({
        ...base,
        severity: 'blocking-error',
        code: 'invalid-text',
        message: 'Existe texto onde uma nota é esperada.',
        recommendedAction:
          'Informe uma nota válida ou apague esse lançamento e importe a planilha novamente.',
        foundValue: displayValue(raw),
      }),
    ];
  }

  if (numeric < 0) {
    return [
      diagnostic({
        ...base,
        severity: 'blocking-error',
        code: 'negative-grade',
        message: 'Existe uma nota negativa onde uma nota válida é esperada.',
        recommendedAction:
          'Corrija ou apague o lançamento negativo e importe a planilha novamente.',
        foundValue: displayValue(raw),
      }),
    ];
  }

  if (!hasExactThousandths(numeric)) {
    return [
      diagnostic({
        ...base,
        severity: 'blocking-error',
        code: 'invalid-precision',
        message: 'Existe uma nota com mais de três casas decimais.',
        recommendedAction:
          'Corrija o lançamento para no máximo três casas decimais. O Banco não arredonda notas silenciosamente durante a importação.',
        foundValue: displayValue(raw),
      }),
    ];
  }

  if (
    input.maximum !== undefined &&
    input.maximum !== null &&
    numeric * 1000 > input.maximum + 1e-7
  ) {
    return [
      diagnostic({
        ...base,
        severity: 'warning',
        code: 'above-maximum',
        message: 'A nota lançada está acima do máximo configurado para esta avaliação.',
        recommendedAction:
          'Confira o lançamento na planilha. O valor é preservado como foi informado e não bloqueia os demais dados válidos.',
        foundValue: displayValue(raw),
        cause: `Máximo configurado: ${new Intl.NumberFormat('pt-BR', {
          maximumFractionDigits: 3,
        }).format(input.maximum / 1000)}.`,
      }),
    ];
  }

  return [];
}

function maximumMilli(sheet: GradeSheetRecognition, sourceSlot: string): number | null {
  const definition = sheet.assessmentDefinitions.find((value) => value.sourceSlot === sourceSlot);
  const configuration = definition?.maximumConfiguration;
  if (!configuration || configuration.state !== 'numeric' || configuration.rawValue <= 0)
    return null;
  return Math.round(configuration.rawValue * 1000);
}

function qualitativeLabel(sheet: GradeSheetRecognition, index: number): string {
  const slot = SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2[index];
  const definition = slot
    ? sheet.assessmentDefinitions.find((value) => value.sourceSlot === slot.sourceSlot)
    : undefined;
  if (definition?.kind === 'qualitative-activity' && definition.name.state === 'text') {
    const name = definition.name.rawValue.trim();
    if (name) return `Atividade ${index + 1} — ${name}`;
  }
  return `Atividade ${index + 1}`;
}

function inspectRequiredMaximum(
  sheet: GradeSheetRecognition,
  sourceSlot: 'R' | 'S',
  label: string,
): readonly GradebookImportDiagnosticV1[] {
  const definition = sheet.assessmentDefinitions.find((value) => value.sourceSlot === sourceSlot);
  const configuration = definition?.maximumConfiguration;
  if (configuration?.state === 'numeric' && configuration.rawValue > 0) return [];
  const technical = configuration?.provenance;
  return [
    diagnostic({
      severity: 'blocking-error',
      code: 'invalid-maximum',
      message: `O valor máximo de ${label.toLowerCase()} está ausente ou inválido.`,
      recommendedAction:
        'Informe um máximo numérico positivo na configuração da avaliação e importe novamente.',
      classCode: sheet.className.trim().toUpperCase(),
      subject: sheet.discipline.trim() || undefined,
      period: periodLabel(sheet),
      fieldKind: 'configuration',
      fieldLabel: `Máximo de ${label}`,
      foundValue:
        configuration && 'rawValue' in configuration
          ? displayValue(configuration.rawValue)
          : undefined,
      sheetName: technical?.sheetName ?? sheet.name,
      cellAddress: technical?.cellAddress,
    }),
  ];
}

type QualitativeMaximumBaseV1 = {
  classCode: string;
  subject: string | undefined;
  period: ReturnType<typeof periodLabel>;
  fieldKind: 'configuration';
  slot: number;
  fieldLabel: string;
  sheetName: string;
  cellAddress: string;
};
type QualitativeNameStateV1 = Extract<
  GradeSheetRecognition['assessmentDefinitions'][number],
  { kind: 'qualitative-activity' }
>['name'];
type QualitativeMaximumConfigurationV1 = NonNullable<
  GradeSheetRecognition['assessmentDefinitions'][number]['maximumConfiguration']
>;

/** Whether any student row (5 to 50) has a value in the activity's column. */
function hasQualitativeStudentValueV1(
  sheet: GradeSheetRecognition,
  slot: (typeof SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2)[number],
): boolean {
  for (const student of sheet.students) {
    if (student.row < 5 || student.row > 50) continue;
    const raw = snapshot(sheet, `${slot.studentValueColumn}${student.row}`);
    if (
      raw !== undefined &&
      raw !== null &&
      !Array.isArray(raw) &&
      !(typeof raw === 'string' && raw.trim() === '')
    )
      return true;
  }
  return false;
}

/** A name that could not be read, unless the cell still holds the template's ordinal. */
function qualitativeNameDiagnosticV1(
  base: QualitativeMaximumBaseV1,
  nameState: QualitativeNameStateV1 | undefined,
  index: number,
): GradebookImportDiagnosticV1 | undefined {
  const templateOrdinal =
    nameState?.state === 'unrecognized' &&
    typeof nameState.rawValue === 'number' &&
    nameState.rawValue === index + 1;
  if (
    templateOrdinal ||
    (nameState?.state !== 'missing-field' && nameState?.state !== 'unrecognized')
  )
    return undefined;
  return (
      diagnostic({
        ...base,
        severity: 'warning',
        code: 'source-unavailable',
        fieldLabel: `Nome da atividade ${index + 1}`,
        sheetName: nameState.provenance.sheetName,
        cellAddress: nameState.provenance.cellAddress,
        message: 'O nome de uma atividade não pôde ser lido na planilha.',
        recommendedAction:
          'Confira a célula indicada e salve a planilha novamente. O Banco preserva o nome atual enquanto a origem estiver indisponível.',
        cause:
          nameState.state === 'missing-field'
            ? 'A célula de nome não foi encontrada na estrutura lida do arquivo.'
            : 'A célula de nome contém um tipo de valor que não pode ser usado como rótulo.',
        ...('rawValue' in nameState
          ? { foundValue: displayValue(nameState.rawValue) }
          : {}),
      })
  );
}

const QUALITATIVE_MAXIMUM_INVALID_V1 = 'O máximo informado não é um número positivo.';
const QUALITATIVE_MAXIMUM_CAUSES_V1: Partial<Record<string, string>> = {
  'ambiguous-empty': 'A atividade ainda possui nome ou lançamento, mas a célula de máximo está vazia.',
  'ambiguous-marker': 'A célula de máximo contém o marcador * em vez de um número positivo.',
  unrecognized: 'A célula de máximo contém um valor que não pôde ser interpretado como número.',
};

/** The maximum that could not be read or is not a positive number, unless the activity was
 * deleted entirely (empty maximum, no name and no student value). */
function qualitativeMaximumDiagnosticV1(
  base: QualitativeMaximumBaseV1,
  configuration: QualitativeMaximumConfigurationV1 | undefined,
  name: string,
  hasStudentValue: boolean,
): GradebookImportDiagnosticV1 | undefined {
  if (!configuration || configuration.state === 'missing-field') {
    return diagnostic({
      ...base,
      severity: 'warning',
      code: 'source-unavailable',
      message: 'O máximo de uma atividade não pôde ser lido na planilha.',
      recommendedAction:
        'Confira a célula indicada, recalcule/salve o arquivo no Excel e importe novamente. O Banco preserva a definição atual enquanto a origem estiver indisponível.',
      cause: 'A célula de máximo não foi encontrada na estrutura lida do arquivo.',
    });
  }

  if (configuration.state === 'numeric' && configuration.rawValue > 0) return undefined;

  const trulyDeleted =
    configuration.state === 'ambiguous-empty' && !name && !hasStudentValue;
  if (trulyDeleted) return undefined;

  const found =
    'rawValue' in configuration ? displayValue(configuration.rawValue) : undefined;
  const cause = QUALITATIVE_MAXIMUM_CAUSES_V1[configuration.state] ?? QUALITATIVE_MAXIMUM_INVALID_V1;
  return diagnostic({
    ...base,
    severity: 'warning',
    code: 'invalid-maximum',
    message: 'O máximo de uma atividade está ausente ou inválido.',
    recommendedAction:
      'Corrija a célula de máximo indicada ou apague integralmente a atividade se ela não existir mais; depois importe novamente.',
    ...(found === undefined ? {} : { foundValue: found }),
    cause,
  });
}

function inspectQualitativeDefinitionMaximum(
  sheet: GradeSheetRecognition,
): readonly GradebookImportDiagnosticV1[] {
  const result: GradebookImportDiagnosticV1[] = [];
  for (const [index, slot] of SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.entries()) {
    const definition = sheet.assessmentDefinitions.find(
      (value) => value.sourceSlot === slot.sourceSlot,
    );
    const configuration = definition?.maximumConfiguration;
    const name =
      definition?.kind === 'qualitative-activity' && definition.name.state === 'text'
        ? definition.name.rawValue.trim()
        : '';
    const hasStudentValue = hasQualitativeStudentValueV1(sheet, slot);

    const base = {
      classCode: sheet.className.trim().toUpperCase(),
      subject: sheet.discipline.trim() || undefined,
      period: periodLabel(sheet),
      fieldKind: 'configuration' as const,
      slot: 11 + index,
      fieldLabel: `Máximo de ${qualitativeLabel(sheet, index)}`,
      sheetName: configuration?.provenance.sheetName ?? sheet.name,
      cellAddress: configuration?.provenance.cellAddress ?? slot.maximumCell,
    };

    const nameState =
      definition?.kind === 'qualitative-activity' ? definition.name : undefined;
    const nameDiagnostic = qualitativeNameDiagnosticV1(base, nameState, index);
    if (nameDiagnostic) result.push(nameDiagnostic);

    const maximumDiagnostic = qualitativeMaximumDiagnosticV1(base, configuration, name, hasStudentValue);
    if (maximumDiagnostic) result.push(maximumDiagnostic);
  }
  return result;
}
function inspectDuplicateStudentNumbers(
  sheet: GradeSheetRecognition,
): readonly GradebookImportDiagnosticV1[] {
  const seen = new Set<number>();
  const result: GradebookImportDiagnosticV1[] = [];
  for (const student of sheet.students) {
    const number = studentNumber(student);
    if (number === undefined) continue;
    if (!seen.has(number)) {
      seen.add(number);
      continue;
    }
    result.push(
      diagnostic({
        severity: 'blocking-error',
        code: 'duplicate-student-number',
        message: 'O mesmo número de aluno aparece mais de uma vez nesta turma e período.',
        recommendedAction: 'Corrija a duplicidade na planilha e importe novamente.',
        classCode: sheet.className.trim().toUpperCase(),
        subject: sheet.discipline.trim() || undefined,
        period: periodLabel(sheet),
        studentNumber: number,
        studentName: student.name.trim() || undefined,
        fieldKind: 'student',
        fieldLabel: 'Número do aluno',
        sheetName: sheet.name,
        cellAddress: `J${student.row}`,
      }),
    );
  }
  return result;
}

function inspectTrimesterSheet(
  sheet: GradeSheetRecognition,
): readonly GradebookImportDiagnosticV1[] {
  const diagnostics: GradebookImportDiagnosticV1[] = [
    ...inspectRequiredMaximum(sheet, 'R', 'Avaliação quantitativa 1'),
    ...inspectRequiredMaximum(sheet, 'S', 'Avaliação quantitativa 2'),
    ...inspectQualitativeDefinitionMaximum(sheet),
    ...inspectDuplicateStudentNumbers(sheet),
  ];
  const fixed = [
    {
      column: 'R',
      slot: 1,
      label: 'Avaliação quantitativa 1',
      maximum: maximumMilli(sheet, 'R'),
    },
    {
      column: 'S',
      slot: 2,
      label: 'Avaliação quantitativa 2',
      maximum: maximumMilli(sheet, 'S'),
    },
    { column: 'Z', slot: 3, label: 'Avaliação paralela', maximum: null },
  ] as const;

  for (const student of sheet.students) {
    for (const field of fixed) {
      diagnostics.push(
        ...inspectCell({
          sheet,
          student,
          address: `${field.column}${student.row}`,
          fieldKind: 'assessment',
          fieldLabel: field.label,
          slot: field.slot,
          maximum: field.maximum,
        }),
      );
    }
    for (const [index, slot] of SOURCE_QUALITATIVE_ACTIVITY_SLOTS_V2.entries()) {
      diagnostics.push(
        ...inspectCell({
          sheet,
          student,
          address: `${slot.studentValueColumn}${student.row}`,
          fieldKind: 'assessment',
          fieldLabel: qualitativeLabel(sheet, index),
          slot: 11 + index,
          maximum: maximumMilli(sheet, slot.sourceSlot),
        }),
      );
    }
    if (student.termResultObservations) {
      diagnostics.push(
        ...inspectCell({
          sheet,
          student,
          address: `AM${student.row}`,
          fieldKind: 'term-result',
          fieldLabel: 'Nota do trimestre',
          observation: student.termResultObservations.officialTermGrade,
        }),
      );
    }
  }
  return diagnostics;
}

function inspectRecoverySheet(
  sheet: GradeSheetRecognition,
): readonly GradebookImportDiagnosticV1[] {
  const diagnostics: GradebookImportDiagnosticV1[] = [...inspectDuplicateStudentNumbers(sheet)];
  for (const student of sheet.students) {
    const observations = student.recovery?.resultObservations;
    if (!observations) continue;
    const fields = [
      {
        column: 'R',
        label: 'Recuperação do 1º trimestre',
        observation: observations.trimester1,
        allowRecoveryMarkers: true,
      },
      {
        column: 'S',
        label: 'Recuperação do 2º trimestre',
        observation: observations.trimester2,
        allowRecoveryMarkers: true,
      },
      {
        column: 'T',
        label: 'Recuperação do 3º trimestre',
        observation: observations.trimester3,
        allowRecoveryMarkers: true,
      },
      {
        column: 'U',
        label: 'Resultado anual após recuperação',
        observation: observations.totalAfterRecovery,
        allowRecoveryMarkers: false,
      },
    ] as const;
    for (const field of fields) {
      diagnostics.push(
        ...inspectCell({
          sheet,
          student,
          address: `${field.column}${student.row}`,
          fieldKind: 'recovery',
          fieldLabel: field.label,
          allowRecoveryMarkers: field.allowRecoveryMarkers,
          observation: field.observation,
        }),
      );
    }
  }
  return diagnostics;
}

export function collectGradebookImportDiagnosticsV1(
  result: BatchSuccess,
): readonly GradebookImportDiagnosticV1[] {
  const summary = result.summary as SummaryWithRelationV9;
  if (summary.masterRelationV9) return [];
  const diagnostics: GradebookImportDiagnosticV1[] = [];
  for (const sheet of summary.gradeSheets) {
    if (
      sheet.stage === 'trimester-1' ||
      sheet.stage === 'trimester-2' ||
      sheet.stage === 'trimester-3'
    ) {
      diagnostics.push(...inspectTrimesterSheet(sheet));
    } else if (sheet.stage === 'recovery') {
      diagnostics.push(...inspectRecoverySheet(sheet));
    }
  }
  return diagnostics;
}

export function blockingGradebookImportDiagnosticsV1(
  diagnostics: readonly GradebookImportDiagnosticV1[],
): readonly GradebookImportDiagnosticV1[] {
  return diagnostics.filter((value) => value.severity === 'blocking-error');
}

export function warningGradebookImportDiagnosticsV1(
  diagnostics: readonly GradebookImportDiagnosticV1[],
): readonly GradebookImportDiagnosticV1[] {
  return diagnostics.filter((value) => value.severity === 'warning');
}

/** User-facing preflight stays intentionally narrower than the internal source diagnostics.
 * Technical/unavailable states still drive canonical preservation and audit replacement, but
 * only blocking errors and above-maximum warnings require operator attention.
 */
export function actionableGradebookImportDiagnosticsV1(
  diagnostics: readonly GradebookImportDiagnosticV1[],
): readonly GradebookImportDiagnosticV1[] {
  return diagnostics.filter(
    (value) => value.severity === 'blocking-error' || value.code === 'above-maximum',
  );
}

export function sourceUnavailableGradebookImportDiagnosticsV1(
  diagnostics: readonly GradebookImportDiagnosticV1[],
): readonly GradebookImportDiagnosticV1[] {
  return diagnostics.filter((value) => value.code === 'source-unavailable');
}

function bounded(value: string, maximum: number): string {
  return value.trim().slice(0, maximum);
}

export function gradebookImportDiagnosticsAuditRequestV1(
  result: BatchSuccess,
  diagnostics: readonly GradebookImportDiagnosticV1[],
): GradebookImportDiagnosticsAuditRequestV1 {
  const summary = result.summary as SummaryWithRelationV9;
  return {
    version: GRADEBOOK_IMPORT_DIAGNOSTICS_VERSION_V1,
    academicYear: Number.isSafeInteger(summary.academicYear)
      ? (summary.academicYear as number)
      : null,
    fileName: result.manifest.fileName.slice(0, 255),
    sha256: result.manifest.sha256,
    diagnostics: diagnostics.map(({ studentName: _studentName, ...value }) => ({
      ...value,
      key: value.key.slice(0, 320),
      message: value.message.slice(0, 300),
      recommendedAction: value.recommendedAction.slice(0, 500),
      ...(value.classCode ? { classCode: bounded(value.classCode, 24) } : {}),
      ...(value.subject ? { subject: bounded(value.subject, 160) } : {}),
      ...(value.period ? { period: bounded(value.period, 64) } : {}),
      ...(value.fieldLabel ? { fieldLabel: bounded(value.fieldLabel, 240) } : {}),
      ...(value.foundValue ? { foundValue: bounded(value.foundValue, 240) } : {}),
      ...(value.cause ? { cause: bounded(value.cause, 240) } : {}),
      ...(value.sheetName ? { sheetName: bounded(value.sheetName, 80) } : {}),
      ...(value.cellAddress ? { cellAddress: bounded(value.cellAddress, 24) } : {}),
    })),
  };
}

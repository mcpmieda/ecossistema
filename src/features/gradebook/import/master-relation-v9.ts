import type { GradebookRelationClassV9, GradebookRelationStudentV9 } from '../../../../shared/gradebook-contracts/imports/import-persistence-transport-v9';
import type { Workbook, Worksheet } from './spreadsheet-recognizer';
import { trimEndCharsV1 } from '../../../../shared/trim-chars-v1';

export interface MasterRelationRecognitionV9 {
  readonly ano: number;
  readonly turmas: readonly GradebookRelationClassV9[];
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/gu, '')
    .trim()
    .replaceAll(/\s+/gu, ' ')
    .toUpperCase();
}

function cell(sheet: Worksheet, address: string): { v?: unknown; w?: string } | null {
  const value = sheet[address];
  return value && typeof value === 'object' ? value : null;
}

function text(sheet: Worksheet, address: string): string {
  const value = cell(sheet, address);
  if (!value) return '';
  if (typeof value.v === 'string') return value.v.trim();
  if (typeof value.v === 'number') return String(value.v);
  if (typeof value.w === 'string') return value.w.trim();
  return '';
}

function integer(sheet: Worksheet, address: string): number | null {
  const value = cell(sheet, address)?.v;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  const parsed = Number(text(sheet, address).replace(',', '.'));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function academicYear(value: number | null): number | null {
  return value !== null && value >= 2000 && value <= 2200 ? value : null;
}

function resolveAcademicYear(inicio: Worksheet): number {
  const resolved = academicYear(integer(inicio, 'Q2'));
  if (resolved === null) {
    throw new Error('Ano letivo inválido ou ausente em INICIO!Q2.');
  }
  return resolved;
}

function columnName(oneBased: number): string {
  let value = oneBased;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCodePoint(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export function parseRelationStatusV9(raw: string): readonly [GradebookRelationStudentV9[2], string?] {
  const status = trimEndCharsV1(normalize(raw), '.').trim();
  if (!status || status === 'NOVATO') return [0];
  if (status === 'ESPECIAL') return [1];
  if (status === 'ASSISTIDO') return [2];
  if (status === 'DESISTENTE') return [3];
  if (status === 'TRANSFERIDO') return [4];
  if (status === 'FALECIDO') return [5];
  // "FOI PARA O 6º ANO" and "FOI PARA 6º ANO"; a destination named just "O" stays "O".
  const foi = /^FOI\s+PARA\s+(\S.*)$/u.exec(status);
  const destination = foi?.[1] ? (/^O\s+(\S.*)$/u.exec(foi[1])?.[1] ?? foi[1]) : undefined;
  if (destination) return [6, destination.trim().toUpperCase()];
  const estava = /^ESTAVA\s+NO\s+(\S.*)$/u.exec(status);
  if (estava?.[1]) return [7, estava[1].trim().toUpperCase()];
  throw new Error(`Situação da Relação não reconhecida: ${raw.trim()}`);
}

/** One class's students in VINCULO AGENDA: its pair of columns (situation, name), rows 3 to 48. */
function relationStudentsV9(agenda: NonNullable<Workbook['Sheets'][string]>, relationIndex: number) {
  const statusColumn = columnName(9 + relationIndex * 2); // I, K, M ... AY
  const nameColumn = columnName(10 + relationIndex * 2); // J, L, N ... AZ
  const alunos: GradebookRelationStudentV9[] = [];
  for (let agendaRow = 3; agendaRow <= 48; agendaRow += 1) {
    const studentName = text(agenda, `${nameColumn}${agendaRow}`).trim();
    if (!studentName || studentName === '0') continue;
    const numero = agendaRow - 2;
    const [situacao, relacionada] = parseRelationStatusV9(text(agenda, `${statusColumn}${agendaRow}`));
    alunos.push(
      relacionada === undefined
        ? ([numero, studentName, situacao] as const)
        : ([numero, studentName, situacao, relacionada] as const),
    );
  }
  return alunos;
}

/** A transfer (6) or a "was in" (7) must name a class of this Relação. */
function checkRelationMovementsV9(turmas: readonly GradebookRelationClassV9[]) {
  const codes = new Set(turmas.map((turma) => turma.codigo.trim().toUpperCase()));
  for (const turma of turmas) {
    for (const aluno of turma.alunos) {
      if ((aluno[2] === 6 || aluno[2] === 7) && !codes.has(aluno[3]!.trim().toUpperCase())) {
        throw new Error(`Movimentação de ${aluno[1]} referencia turma inexistente: ${aluno[3]}.`);
      }
    }
  }
}

export function recognizeMasterRelationV9(workbook: Workbook): MasterRelationRecognitionV9 | null {
  const inicioName = workbook.SheetNames.find((name) => normalize(name) === 'INICIO');
  const agendaName = workbook.SheetNames.find((name) => normalize(name).includes('VINCULO AGENDA'));
  if (!inicioName || !agendaName) return null;
  const inicio = workbook.Sheets[inicioName];
  const agenda = workbook.Sheets[agendaName];
  if (!inicio || !agenda) return null;

  const ano = resolveAcademicYear(inicio);

  const turmas: GradebookRelationClassV9[] = [];
  for (let sourceRow = 7; sourceRow <= 28; sourceRow += 1) {
    const codigo = text(inicio, `E${sourceRow}`).trim().toUpperCase();
    const nome = text(inicio, `F${sourceRow}`).trim();
    if (!codigo && !nome) continue;
    if (!codigo || !nome) throw new Error(`Turma incompleta na linha ${sourceRow} de INICIO.`);
    const etapa = integer(inicio, `D${sourceRow}`);
    const turno = text(inicio, `I${sourceRow}`).trim();
    if (etapa === null || etapa <= 0 || !turno) {
      throw new Error(`Metadados incompletos da turma ${codigo} em INICIO.`);
    }

    const alunos = relationStudentsV9(agenda, sourceRow - 7);
    turmas.push({ codigo, nome, etapa, turno, alunos });
  }

  if (turmas.length === 0) throw new Error('Nenhuma turma foi encontrada na Relação.');
  checkRelationMovementsV9(turmas);
  return { ano, turmas };
}

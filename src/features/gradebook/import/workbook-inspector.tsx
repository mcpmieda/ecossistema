import { Alert, Chip, Surface } from '@heroui/react';
import { CheckCircle2 } from 'lucide-react';
import { abbreviateSha256 } from './file-manifest';
import {
  countWorkbookOperationalClassesV1,
  workbookClassComponentsV1,
  type BatchSuccess,
} from './import-batch';
import {
  formatNote,
  noteCount,
  recoverySheets,
  stageLabel,
  trimesterSheets,
} from './spreadsheet-recognizer';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'Não informado';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function WorkbookInspector({ result }: Readonly<{ result: BatchSuccess }>) {
  const { manifest, summary: workbook } = result;
  const operationalClasses = countWorkbookOperationalClassesV1(workbook);
  const totalStudents = workbook.classes.reduce((sum, classroom) => sum + classroom.students, 0);
  const trimesterGuides = workbook.gradeSheets.filter((sheet) =>
    sheet.stage.startsWith('trimester'),
  ).length;
  const recoveryClasses = workbook.classes.filter((classroom) => classroom.recovery).length;

  return (
    <div className="mt-5">
      <Alert status="success">
        <Alert.Indicator>
          <CheckCircle2 className="size-4" />
        </Alert.Indicator>
        <Alert.Content>
          <Alert.Title>Padrão de notas reconhecido</Alert.Title>
          <Alert.Description>
            {workbook.fileName} · {workbook.format} · {formatBytes(workbook.size)} ·{' '}
            {workbook.sheets.length} aba(s)
          </Alert.Description>
        </Alert.Content>
      </Alert>

      <Surface variant="secondary" className="mt-4 rounded-2xl p-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">
              Identidade técnica
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer text-sm font-medium">
                SHA-256 <code>{abbreviateSha256(manifest.sha256)}</code>
              </summary>
              <code className="mt-2 block break-all text-xs text-muted">{manifest.sha256}</code>
            </details>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">Origem</p>
            <p className="mt-2 break-all text-sm font-medium">{manifest.fileName}</p>
            <p className="mt-1 text-xs text-muted">
              {manifest.extension.toUpperCase()} ·{' '}
              {manifest.reportedMimeType ?? 'MIME não informado'}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">Arquivo</p>
            <p className="mt-2 text-sm font-medium">{formatBytes(manifest.sizeBytes)}</p>
            <p className="mt-1 text-xs text-muted">
              Modificado em {formatTimestamp(manifest.lastModifiedAt)}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">
              Processamento
            </p>
            <p className="mt-2 text-sm font-medium">Reconhecimento concluído</p>
            <p className="mt-1 text-xs text-muted">
              Fonte v{manifest.sourceContractVersion} · parser {manifest.parserVersion}
            </p>
            <p className="mt-1 text-xs text-muted">Lido em {formatTimestamp(manifest.readAt)}</p>
          </div>
        </div>
      </Surface>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ['Turmas', operationalClasses, 'turma + componente D<n>'],
          ['Relações', workbook.classes.length, 'turmas físicas / rosters'],
          ['Alunos', totalStudents, 'posições únicas por relação'],
          ['Trimestres', trimesterGuides, 'guias de 1º, 2º e 3º'],
          ['Recuperação', recoveryClasses, 'turma(s) com guia REC'],
        ].map(([label, value, detail]) => (
          <Surface key={String(label)} variant="secondary" className="rounded-2xl p-4">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted">{label}</p>
            <p className="mt-2 text-2xl font-semibold">{value}</p>
            <p className="mt-1 text-xs text-muted">{detail}</p>
          </Surface>
        ))}
      </div>

      <div className="mt-5 space-y-4">
        {workbook.classes.map((classroom) => (
          <Surface
            key={classroom.name}
            variant="default"
            className="rounded-3xl border border-border/60 p-5"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="mr-1 text-lg font-semibold">{classroom.name}</h3>
              <Chip variant="soft" size="sm">
                {classroom.students} alunos
              </Chip>
              {workbookClassComponentsV1(classroom).map((component) => (
                <Chip
                  key={`${component.disciplineIndex}|${component.discipline}`}
                  color="accent"
                  variant="soft"
                  size="sm"
                >
                  {component.disciplineIndex} · {component.discipline || 'Componente'}
                </Chip>
              ))}
              {classroom.declaredStudents !== null && (
                <Chip variant="soft" size="sm">
                  J1: {classroom.declaredStudents}
                </Chip>
              )}
              {classroom.trimesters.map((period) => (
                <Chip key={period} color="success" variant="soft" size="sm">
                  {period}
                </Chip>
              ))}
              {classroom.recovery && (
                <Chip color="accent" variant="soft" size="sm">
                  REC
                </Chip>
              )}
            </div>
            <p className="mt-2 text-sm text-muted">
              {classroom.disciplines.length
                ? classroom.disciplines.join(' · ')
                : 'Disciplina não informada em K2'}
            </p>

            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium">
                Ver leitura por trimestre
              </summary>
              <div className="mt-3 space-y-3">
                {trimesterSheets(classroom.sheets).map((sheet) => {
                  const q = noteCount(sheet.students.map((student) => student.quantitativeTotal));
                  const ql = noteCount(sheet.students.map((student) => student.qualitativeTotal));
                  const activities = sheet.students.reduce(
                    (sum, student) => sum + noteCount(student.qualitative),
                    0,
                  );
                  const official = noteCount(sheet.students.map((student) => student.official));

                  return (
                    <Surface key={sheet.name} variant="secondary" className="rounded-2xl p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="mr-auto font-semibold">
                          {stageLabel(sheet.stage)} · {sheet.discipline || sheet.disciplineIndex}
                        </p>
                        <Chip variant="soft" size="sm">
                          {sheet.disciplineIndex}
                        </Chip>
                        <Chip variant="soft" size="sm">
                          {sheet.students.length} alunos
                        </Chip>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Chip variant="soft" size="sm">
                          Q/T: {q}
                        </Chip>
                        <Chip variant="soft" size="sm">
                          AA:AJ: {activities}
                        </Chip>
                        <Chip variant="soft" size="sm">
                          QL/AK: {ql}
                        </Chip>
                        <Chip variant="soft" size="sm">
                          Oficial/AM: {official}
                        </Chip>
                        {sheet.formulas > 0 && (
                          <Chip color="accent" variant="soft" size="sm">
                            Fórmulas: {sheet.formulas}
                          </Chip>
                        )}
                      </div>
                      <div className="mt-3 max-h-64 overflow-auto rounded-xl border border-border/50">
                        {sheet.students.map((student) => (
                          <div
                            key={`${sheet.name}-${student.row}`}
                            className="grid min-w-[32rem] grid-cols-[3rem_minmax(11rem,1fr)_5rem_5rem_5rem] gap-2 border-b border-border/40 px-3 py-2 text-xs last:border-0"
                          >
                            <span className="text-muted">{student.number}</span>
                            <span className="truncate font-medium">{student.name}</span>
                            <span title="Quantitativo">
                              Q {formatNote(student.quantitativeTotal)}
                            </span>
                            <span title="Qualitativo">
                              QL {formatNote(student.qualitativeTotal)}
                            </span>
                            <span title="Nota oficial">AM {formatNote(student.official)}</span>
                          </div>
                        ))}
                      </div>
                    </Surface>
                  );
                })}

                {recoverySheets(classroom.sheets).map((sheet) => {
                  const eligible1 = sheet.students.filter(
                    (student) => student.recovery?.eligibleTrimester1,
                  ).length;
                  const eligible2 = sheet.students.filter(
                    (student) => student.recovery?.eligibleTrimester2,
                  ).length;
                  const eligible3 = sheet.students.filter(
                    (student) => student.recovery?.eligibleTrimester3,
                  ).length;
                  const recoveryNotes = sheet.students.reduce(
                    (sum, student) =>
                      sum +
                      noteCount([
                        student.recovery?.trimester1 ?? null,
                        student.recovery?.trimester2 ?? null,
                        student.recovery?.trimester3 ?? null,
                      ]),
                    0,
                  );
                  const totalsAfterRecovery = noteCount(
                    sheet.students.map((student) => student.recovery?.totalAfterRecovery ?? null),
                  );

                  return (
                    <Surface key={sheet.name} variant="secondary" className="rounded-2xl p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="mr-auto font-semibold">
                          Recuperação final · {sheet.discipline || sheet.disciplineIndex}
                        </p>
                        <Chip variant="soft" size="sm">
                          {sheet.disciplineIndex}
                        </Chip>
                        <Chip variant="soft" size="sm">
                          {sheet.students.length} alunos
                        </Chip>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Chip variant="soft" size="sm">
                          Elegíveis 1º: {eligible1}
                        </Chip>
                        <Chip variant="soft" size="sm">
                          Elegíveis 2º: {eligible2}
                        </Chip>
                        <Chip variant="soft" size="sm">
                          Elegíveis 3º: {eligible3}
                        </Chip>
                        <Chip variant="soft" size="sm">
                          Notas REC: {recoveryNotes}
                        </Chip>
                        <Chip variant="soft" size="sm">
                          Totais pós-REC/U: {totalsAfterRecovery}
                        </Chip>
                        {sheet.formulas > 0 && (
                          <Chip color="accent" variant="soft" size="sm">
                            Fórmulas: {sheet.formulas}
                          </Chip>
                        )}
                      </div>
                      <div className="mt-3 max-h-72 overflow-auto rounded-xl border border-border/50">
                        <div className="min-w-[62rem]">
                          <div className="grid grid-cols-[3rem_minmax(12rem,1fr)_5rem_5rem_5rem_5rem_5rem_5rem_6rem_6rem] gap-2 border-b border-border/50 px-3 py-2 text-[11px] font-medium text-muted">
                            <span>Nº</span>
                            <span>Aluno</span>
                            <span>1º orig.</span>
                            <span>REC 1º</span>
                            <span>2º orig.</span>
                            <span>REC 2º</span>
                            <span>3º orig.</span>
                            <span>REC 3º</span>
                            <span>Total orig.</span>
                            <span>Pós-REC</span>
                          </div>
                          {sheet.students.map((student) => {
                            const recovery = student.recovery;
                            return (
                              <div
                                key={`${sheet.name}-${student.row}`}
                                className="grid grid-cols-[3rem_minmax(12rem,1fr)_5rem_5rem_5rem_5rem_5rem_5rem_6rem_6rem] gap-2 border-b border-border/40 px-3 py-2 text-xs last:border-0"
                              >
                                <span className="text-muted">{student.number}</span>
                                <span className="truncate font-medium">{student.name}</span>
                                <span>{formatNote(recovery?.originalTrimester1 ?? null)}</span>
                                <span>
                                  {recovery?.eligibleTrimester1 ? '• ' : ''}
                                  {formatNote(recovery?.trimester1 ?? null)}
                                </span>
                                <span>{formatNote(recovery?.originalTrimester2 ?? null)}</span>
                                <span>
                                  {recovery?.eligibleTrimester2 ? '• ' : ''}
                                  {formatNote(recovery?.trimester2 ?? null)}
                                </span>
                                <span>{formatNote(recovery?.originalTrimester3 ?? null)}</span>
                                <span>
                                  {recovery?.eligibleTrimester3 ? '• ' : ''}
                                  {formatNote(recovery?.trimester3 ?? null)}
                                </span>
                                <span>{formatNote(recovery?.originalAnnual ?? null)}</span>
                                <span>{formatNote(recovery?.totalAfterRecovery ?? null)}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      <p className="mt-2 text-xs text-muted">
                        • trimestre marcado pela própria planilha como aplicável à recuperação.
                      </p>
                    </Surface>
                  );
                })}
              </div>
            </details>
          </Surface>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <Chip variant="soft" size="sm">
          SheetJS {workbook.parserVersion}
        </Chip>
        <Chip variant="soft" size="sm">
          Guias de notas: {workbook.gradeSheets.length}
        </Chip>
        {workbook.auxiliarySheets.map((name) => (
          <Chip key={name} variant="soft" size="sm">
            Auxiliar: {name}
          </Chip>
        ))}
        {workbook.unrecognizedSheets.length > 0 && (
          <Chip color="warning" variant="soft" size="sm">
            Não classificadas: {workbook.unrecognizedSheets.length}
          </Chip>
        )}
      </div>
    </div>
  );
}

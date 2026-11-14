import type { GradebookImportDiagnosticCodeV1 } from './import-diagnostics-v1';

/**
 * What each Auditoria finding says and what to do, for readers that only have the stored code
 * (the Auditoria API). Every code of the contract must have its text: a new code without one
 * does not compile, so it never falls back to a generic sentence.
 */
export const GRADEBOOK_IMPORT_DIAGNOSTIC_TEXTS_V1: Readonly<Record<GradebookImportDiagnosticCodeV1, {
  readonly message: string;
  readonly action: string;
}>> = {
  'invalid-text': {
    message: 'Existe texto onde uma nota é esperada.',
    action: 'Informe uma nota válida ou apague o lançamento e importe novamente.',
  },
  'negative-grade': {
    message: 'Existe uma nota negativa onde uma nota válida é esperada.',
    action: 'Corrija ou apague o lançamento negativo e importe novamente.',
  },
  'invalid-precision': {
    message: 'Existe uma nota com mais de três casas decimais.',
    action: 'Corrija o lançamento para no máximo três casas decimais.',
  },
  'invalid-maximum': {
    message: 'O valor máximo de uma avaliação está ausente ou inválido.',
    action: 'Informe um máximo numérico positivo na configuração da avaliação.',
  },
  'duplicate-student-number': {
    message: 'O mesmo número de aluno aparece mais de uma vez na planilha.',
    action: 'Corrija a duplicidade do número do aluno na planilha.',
  },
  'source-unavailable': {
    message: 'Um valor de origem está indisponível.',
    action: 'Recalcule e salve a planilha no Excel antes de reimportar.',
  },
  'above-maximum': {
    message: 'A nota lançada está acima do máximo configurado para esta avaliação.',
    action: 'Corrija a nota ou o máximo na planilha. Essa nota e o resultado do aluno não foram lançados.',
  },
  'activity-without-description': {
    message: 'Atividade com notas e sem descrição.',
    action: 'Preencha a descrição da atividade (linha 4). A coluna não foi lançada.',
  },
  'activity-without-maximum': {
    message: 'Atividade com notas e sem máximo válido.',
    action: 'Informe o máximo da atividade (linha 3). A coluna não foi lançada.',
  },
  'qualitative-over-ceiling': {
    message: 'Atividades do aluno somam mais que o teto qualitativo.',
    action: 'Confira as notas do aluno. As atividades e o resultado dele não foram lançados.',
  },
  'qualitative-maxima-over-ceiling': {
    message: 'Máximos das atividades somam mais que o teto qualitativo.',
    action: 'Distribua os máximos (linha 3) dentro do qualitativo. Os resultados desta guia não foram lançados.',
  },
  'header-mismatch': {
    message: 'Turma ou trimestre do cabeçalho diferente da guia.',
    action: 'Confira K3 e K4. Esta turma e disciplina não foram lançadas.',
  },
  'recovery-above-maximum': {
    message: 'Recuperação acima do máximo do trimestre.',
    action: 'Corrija a nota. Ela e o resultado final do aluno não foram lançados.',
  },
  'work-without-weight': {
    message: 'Trabalho lançado com o bloco de trabalho desligado.',
    action: 'Informe o máximo do trabalho (Y3) ou apague as notas. O resultado do aluno não foi lançado.',
  },
  'one-assessment-mode': {
    message: 'AV2 preenchida no modo de uma avaliação.',
    action: 'Confira L1 ou a AV2. O resultado do aluno não foi lançado.',
  },
  'manual-term-result': {
    message: 'Resultado do trimestre digitado à mão.',
    action: 'Restaure a fórmula do AM. O resultado do aluno não foi lançado.',
  },
  'grade-without-student': {
    message: 'Nota em linha sem aluno.',
    action: 'A nota não foi lançada: confira se foi digitada na linha errada ou se a Relação da planilha está desatualizada.',
  },
  'wrong-year': {
    message: 'Ano da planilha diferente do ano da pasta.',
    action: 'Corrija o ano em CONFIGURAÇÃO!C2 para o ano da pasta. Nada desta planilha foi lançado.',
  },
  'student-name-mismatch': {
    message: 'Nome do aluno diferente da Relação para este número.',
    action: 'Confira o número e o nome do aluno na planilha. As notas dele nesta disciplina não foram lançadas.',
  },
  'student-not-in-relation': {
    message: 'Aluno da planilha não está na Relação do sistema.',
    action: 'Envie a Relação atualizada ao sistema ou confira o número na planilha. As notas deste aluno não foram lançadas.',
  },
  'class-move-review': {
    message: 'Troca de turma que o sistema não conseguiu ligar sozinho.',
    action: 'Confirme os pares na importação manual da Relação (ela mostra a conferência). Nada desta Relação foi lançado.',
  },
};

/** The text of a stored code; an unknown code (an older or newer contract) says so plainly. */
export function gradebookImportDiagnosticTextV1(code: string): { readonly message: string; readonly action: string } {
  return (GRADEBOOK_IMPORT_DIAGNOSTIC_TEXTS_V1 as Readonly<Record<string, { message: string; action: string }>>)[code]
    ?? { message: 'Problema na planilha.', action: 'Confira a planilha e importe novamente.' };
}

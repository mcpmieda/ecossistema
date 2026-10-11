// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  classifyReportClassV1,
  normalizeInepV1,
  normalizeStudentNameV1,
  parseCivilDateV1,
} from '../../shared/student-identity/reconciliation-normalization-v1';
import {
  adoptedStudentNameV1,
  compareReconciliationFieldV1,
  planStudentReconciliationV1,
  reportContentV1,
  type ReconciliationReportRowV1,
  type ReconciliationSourceV1,
  type ReconciliationStudentV1,
} from '../../server/student-identity/reconciliation/domain-v1';
import { normalizeRelationNameV9 } from '../../server/gradebook/application/import/import-relational-relation-plan-v9';

const today = '2026-10-11';
const student: ReconciliationStudentV1 = {
  studentUid: 'synthetic-person-a',
  nameKey: 'ALUNA TESTE',
  classId: 7,
};
function row(overrides: Partial<ReconciliationReportRowV1> = {}): ReconciliationReportRowV1 {
  return {
    sourceRow: 2,
    name: 'Aluna Teste',
    nameKey: 'ALUNA TESTE',
    birthDate: '2013-03-04',
    filiation1: 'Pessoa Sintética',
    filiation1Key: 'PESSOA SINTETICA',
    inep: '001.234',
    inepKey: '001234',
    enrollmentHash: 'synthetic-enrollment-a',
    classLabel: '7A 2026 - MATUTINO',
    classKey: '7A 2026 - MATUTINO',
    classId: 7,
    shift: 'MATUTINO',
    shiftKey: 'MATUTINO',
    stage: 7,
    status: 'Ativo',
    statusKey: 'ATIVO',
    enrolledAt: '2026-02-02',
    transferredAt: null,
    ...overrides,
  };
}
function source(overrides: Partial<ReconciliationSourceV1> = {}): ReconciliationSourceV1 {
  return {
    sourceId: 'synthetic-origin-a',
    studentUid: student.studentUid,
    current: row(),
    ...overrides,
  };
}
function plan(
  rows: readonly ReconciliationReportRowV1[],
  sources: readonly ReconciliationSourceV1[] = [],
  students: readonly ReconciliationStudentV1[] = [student],
  rejectedPairs: readonly { sourceId: string; studentUid: string }[] = [],
) {
  return planStudentReconciliationV1({ rows, sources, students, rejectedPairs });
}

describe('normalização do relatório V1', () => {
  it.each([
    '  José  d’Ávila-Souza ',
    'JOSE\u0301 D’ÁVILA-SOUZA',
    " Ana D'Ávila ",
    '\tJoão\nTeste\t',
  ])('preserva paridade com a Relação para %s', (value) => {
    expect(normalizeStudentNameV1(value)).toBe(normalizeRelationNameV9(value));
  });
  it('não remove apóstrofos, hífens, partículas ou ordem', () => {
    expect(normalizeStudentNameV1(" José de D'Ávila-Souza ")).toBe("JOSE DE D'AVILA-SOUZA");
  });
  it('vazio não é concordância nem divergência', () => {
    expect(compareReconciliationFieldV1(null, null)).toBe('empty');
    expect(compareReconciliationFieldV1(null, 'A')).toBe('empty');
    expect(compareReconciliationFieldV1('A', 'A')).toBe('equal');
    expect(compareReconciliationFieldV1('A', 'B')).toBe('different');
  });
  it('normaliza apenas pontos e espaços de INEP, preservando zeros informados', () => {
    expect(normalizeInepV1(' 001. 234 ')).toEqual({ ok: true, value: '001. 234', key: '001234' });
    expect(normalizeInepV1(1234)).toEqual({ ok: true, value: '1234', key: '1234' });
    expect(normalizeInepV1(' ')).toEqual({ ok: true, value: null, key: null });
  });
  it.each(['1e3', '12-34', '+1234', '12/34', '1,234', '..', Number.MAX_SAFE_INTEGER + 1, 12.5, -1])(
    'rejeita INEP sem interpretação segura: %s',
    (value) => {
      expect(normalizeInepV1(value)).toEqual({ ok: false, reason: 'invalid' });
    },
  );
  it.each([
    [1, false, '1900-01-01'],
    [59, false, '1900-02-28'],
    [61, false, '1900-03-01'],
    [0, true, '1904-01-01'],
    [1462, false, '1904-01-01'],
    ['29/02/2012', false, '2012-02-29'],
    ['2012-02-29', false, '2012-02-29'],
  ] as const)('converte data civil e época Excel: %s / %s', (value, epoch, expected) => {
    expect(parseCivilDateV1(value, epoch, today, true)).toEqual({ ok: true, value: expected });
  });
  it.each([
    60,
    10.5,
    0,
    -1,
    NaN,
    Infinity,
    '29/02/1900',
    '29/02/2013',
    '31/04/2013',
    '2013',
    '03/04/13',
    '2013-3-4',
    '2013-03-04T00:00:00Z',
  ])('rejeita data impossível ou parcial: %s', (value) => {
    expect(parseCivilDateV1(value, false, today, true)).toEqual({ ok: false, reason: 'invalid' });
  });
  it.each([null, '', '  '])('nascimento obrigatório não admite vazio: %s', (value) => {
    expect(parseCivilDateV1(value, false, today, true)).toEqual({ ok: false, reason: 'missing' });
    expect(parseCivilDateV1(value, false, today, false)).toEqual({ ok: true, value: null });
  });
  it('data futura depende da referência recebida do servidor', () => {
    expect(parseCivilDateV1('2026-10-12', false, today, true)).toEqual({
      ok: false,
      reason: 'future',
    });
    expect(parseCivilDateV1(today, false, today, true)).toEqual({ ok: true, value: today });
  });
  it.each([
    ['7A 2026 - MATUTINO', 'Ensino Fundamental de 9 anos - 7º Ano', 'MATUTINO', 7],
    ['8D 2026 -VESPERTINO', 'Ensino Fundamental de 9 anos - 8º Ano', 'VESPERTINO', 8],
  ] as const)('reconhece positivamente rótulo autorizado %s', (label, stage, shift, expected) => {
    expect(classifyReportClassV1(label, stage, shift)).toMatchObject({
      kind: 'regular',
      academicYear: 2026,
      stage: expected,
    });
  });
  it.each([
    'MULTIFUNCIONAL MATUTINO',
    'MULTIFUNCIONAL VESPERTINO',
    'INTEGRAL - ATIVIDADE COMPLEMENTAR 6º, 7º, 8º, 9º ANOS - 2026',
    'AEE',
  ])('exclui modalidade %s', (label) => {
    expect(
      classifyReportClassV1(label, 'Ensino Fundamental de 9 anos - 7º Ano', 'MATUTINO'),
    ).toEqual({ kind: 'excluded' });
  });
  it.each([
    ['7A', 'Ensino Fundamental de 9 anos - 7º Ano', 'MATUTINO'],
    ['7A 2026 - MATUTINO', 'Ensino Fundamental de 9 anos - 8º Ano', 'MATUTINO'],
    ['7A 2026 - MATUTINO', 'Ensino Fundamental de 9 anos - 7º Ano', 'VESPERTINO'],
    ['7A 2026 - MATUTINO', 'Desconhecida', 'MATUTINO'],
  ])('não deduz elegibilidade de formato desconhecido: %s', (label, stage, shift) => {
    expect(classifyReportClassV1(label, stage, shift)).toEqual({ kind: 'unknown' });
  });
});

describe('conciliação determinística por pessoa e origem', () => {
  it('veta primeira associação por nome/turma com ano legado confirmado divergente', () => {
    expect(plan([row()], [], [{ ...student, legacyBirthYear: 2012 }]).rows[0]).toMatchObject({
      studentUid: null,
      reason: 'birth_conflict',
      candidateUids: [student.studentUid],
    });
  });
  it.each([2013, null, undefined])(
    'permite ano legado igual ou ausente sem inventar data: %s',
    (legacyBirthYear) => {
      expect(plan([row()], [], [{ ...student, legacyBirthYear }]).rows[0]).toMatchObject({
        studentUid: student.studentUid,
        rule: 'name_class',
        reason: null,
      });
    },
  );
  it('conserva correção de nascimento de origem já confirmada para o mesmo UID', () => {
    const existing = source({ current: row({ birthDate: '2012-03-04' }) });
    expect(
      plan([row()], [existing], [{ ...student, legacyBirthYear: 2012 }]).rows[0],
    ).toMatchObject({
      studentUid: student.studentUid,
      rule: 'continuity',
      reason: null,
    });
  });
  it('origem reconhecida ainda sem UID não libera divergência do ano legado', () => {
    const existing = source({ studentUid: null });
    expect(
      plan([row()], [existing], [{ ...student, legacyBirthYear: 2012 }]).rows[0],
    ).toMatchObject({
      studentUid: null,
      reason: 'birth_conflict',
    });
  });
  it('origem ausente antiga não desfaz a correção confirmada no perfil selecionado', () => {
    const historical = source({ profileSelected: false });
    const current = source({
      sourceId: 'synthetic-origin-b',
      profileSelected: true,
      current: row({ enrollmentHash: 'new', birthDate: '2012-03-04' }),
    });
    const result = plan(
      [row({ enrollmentHash: 'new', birthDate: '2012-03-04' })],
      [historical, current],
    );
    expect(result.rows[0]).toMatchObject({ studentUid: student.studentUid, rule: 'continuity' });
  });
  it('concilia nome/turma exatos sem dados prévios nem conta e aceita N origens compatíveis', () => {
    const result = plan([row(), row({ sourceRow: 3, enrollmentHash: 'synthetic-enrollment-b' })]);
    expect(result.rows.map((item) => item.studentUid)).toEqual([
      student.studentUid,
      student.studentUid,
    ]);
    expect(result.rows.every((item) => item.rule === 'name_class')).toBe(true);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]?.reason).toBeNull();
  });
  it.each(['2012-03-04', '2013-03-05'])(
    'veta N→1 por divergência de nascimento completo: %s',
    (birthDate) => {
      const result = plan([row(), row({ sourceRow: 3, enrollmentHash: 'synthetic-b', birthDate })]);
      expect(
        result.rows.every((item) => item.reason === 'birth_conflict' && item.studentUid === null),
      ).toBe(true);
      expect(result.profiles).toEqual([]);
    },
  );
  it('não usa nome/turma para sobrescrever nascimento prévio divergente de nova matrícula', () => {
    const result = plan([row({ enrollmentHash: 'new', birthDate: '2013-04-04' })], [source()]);
    expect(result.rows[0]?.reason).toBe('birth_conflict');
  });
  it('homônimos na Relação bloqueiam mesmo diante de evidência de INEP', () => {
    const result = plan(
      [row()],
      [source()],
      [student, { ...student, studentUid: 'synthetic-person-b' }],
    );
    expect(result.rows[0]?.reason).toBe('homonym');
    expect(result.rows[0]?.studentUid).toBeNull();
  });
  it('agrupa por UID distinto quando uma pessoa tem mais de um vínculo acadêmico', () => {
    expect(plan([row()], [], [student, student]).rows[0]?.studentUid).toBe(student.studentUid);
  });
  it('nome corrigido conserva UID pela origem ou pela regra INEP/nascimento', () => {
    const renamed = row({ name: 'Nome Corrigido', nameKey: 'NOME CORRIGIDO' });
    expect(plan([renamed], [source()]).rows[0]?.rule).toBe('continuity');
    expect(plan([{ ...renamed, enrollmentHash: 'new' }], [source()]).rows[0]?.rule).toBe(
      'inep_birth',
    );
  });
  it('INEP corrigido permite regra nome/nascimento/Filiação 1 sem aproximar nomes', () => {
    const changed = row({ enrollmentHash: 'new', inep: '999', inepKey: '999' });
    const result = plan([changed], [source()], [{ ...student, nameKey: 'GRAFIA DA RELACAO' }]);
    expect(result.rows[0]?.rule).toBe('name_birth_filiation');
    expect(result.rows[0]?.studentUid).toBe(student.studentUid);
  });
  it('nascimento corrigido exige hash único, mesmo nome e INEP ou filiação concordante', () => {
    expect(plan([row({ birthDate: '2012-03-04' })], [source()]).rows[0]?.rule).toBe('continuity');
    const weak = row({
      birthDate: '2012-03-04',
      inep: null,
      inepKey: null,
      filiation1: null,
      filiation1Key: null,
    });
    expect(plan([weak], [source()]).rows[0]?.reason).toBe('birth_conflict');
  });
  it('hash reaproveitado sem evidências pessoais não herda origem ou UID', () => {
    const replacement = row({
      name: 'Outra Pessoa',
      nameKey: 'OUTRA PESSOA',
      birthDate: '2014-01-01',
      inep: '999',
      inepKey: '999',
      filiation1: 'Outra Filiação',
      filiation1Key: 'OUTRA FILIACAO',
    });
    const result = plan([replacement], [source()]);
    expect(result.rows[0]).toMatchObject({
      sourceId: null,
      studentUid: null,
      reason: 'source_conflict',
    });
  });
  it('hash alterado conserva a origem somente com continuidade única em ambos os sentidos', () => {
    expect(plan([row({ enrollmentHash: 'new' })], [source()]).rows[0]?.sourceId).toBe(
      'synthetic-origin-a',
    );
    const duplicate = source({
      sourceId: 'synthetic-origin-b',
      current: row({ enrollmentHash: 'old-b' }),
    });
    expect(
      plan([row({ enrollmentHash: 'new' })], [source(), duplicate]).rows[0]?.sourceId,
    ).toBeNull();
    const twoNew = plan(
      [row({ enrollmentHash: 'new' }), row({ sourceRow: 3, enrollmentHash: 'other-new' })],
      [source()],
    );
    expect(twoNew.rows.every((item) => item.sourceId === null)).toBe(true);
  });
  it('origem anterior ainda presente não é consumida como continuidade de uma matrícula nova', () => {
    const result = plan([row(), row({ sourceRow: 3, enrollmentHash: 'new' })], [source()]);
    expect(result.rows[0]?.sourceId).toBe('synthetic-origin-a');
    expect(result.rows[1]?.sourceId).toBeNull();
    expect(result.rows[1]?.studentUid).toBe(student.studentUid);
  });
  it('regras conflitantes não escolhem o primeiro UID', () => {
    const other = source({
      sourceId: 'synthetic-origin-b',
      studentUid: 'synthetic-person-b',
      current: row({ nameKey: 'OUTRO NOME', enrollmentHash: 'other' }),
    });
    const result = plan([row({ enrollmentHash: 'new' })], [other]);
    expect(result.rows[0]).toMatchObject({ reason: 'identity_conflict', studentUid: null });
  });
  it('gêmeos ou irmãos com nome/INEP diferentes não são unidos', () => {
    const sibling = row({
      name: 'Pessoa Distinta',
      nameKey: 'PESSOA DISTINTA',
      inep: '999',
      inepKey: '999',
      enrollmentHash: 'new',
    });
    expect(plan([sibling], [source()]).rows[0]?.reason).toBe('sibling_candidate');
  });
  it.each([
    ['swapped', false],
    ['swapped', true],
    ['reused', false],
    ['reused', true],
    ['historical', false],
    ['historical', true],
  ] as const)(
    'hash %s não contorna rejeição por nascimento/filiação iguais; ordem reversa %s',
    (kind, reverse) => {
      const other = row({
        sourceRow: 3,
        name: 'Pessoa Distinta',
        nameKey: 'PESSOA DISTINTA',
        inep: '999',
        inepKey: '999',
        enrollmentHash: 'synthetic-enrollment-b',
      });
      const linked = source({ history: [row({ enrollmentHash: 'synthetic-historical-a' })] });
      const rejected = source({
        sourceId: 'synthetic-origin-b',
        studentUid: null,
        current: other,
      });
      const changed = [
        row({ enrollmentHash: kind === 'swapped' ? other.enrollmentHash : 'synthetic-new-a' }),
        {
          ...other,
          enrollmentHash: kind === 'historical' ? 'synthetic-historical-a' : row().enrollmentHash,
        },
      ];
      const result = plan(
        reverse ? [...changed].reverse() : changed,
        reverse ? [rejected, linked] : [linked, rejected],
        [student],
        [{ sourceId: rejected.sourceId, studentUid: student.studentUid }],
      );
      expect(result.rows.find((item) => item.sourceRow === other.sourceRow)).toMatchObject({
        sourceId: null,
        studentUid: null,
        reason: 'rejected',
        candidateUids: [student.studentUid],
      });
      expect(result.rows.find((item) => item.sourceRow === 2)?.sourceId).not.toBe(
        rejected.sourceId,
      );
      expect(result.profiles).toEqual([]);
    },
  );
  it('hash reutilizado não estabelece continuidade de parentes sem INEP', () => {
    const other = row({
      name: 'Pessoa Distinta',
      nameKey: 'PESSOA DISTINTA',
      inep: null,
      inepKey: null,
    });
    expect(plan([other], [source()]).rows[0]).toMatchObject({
      sourceId: null,
      studentUid: null,
      reason: 'source_conflict',
    });
  });
  describe('gêmeos já conciliados na reimportação', () => {
    const twinStudent: ReconciliationStudentV1 = {
      studentUid: 'synthetic-person-b',
      nameKey: 'PESSOA DISTINTA',
      classId: 7,
    };
    const twinRow = (overrides: Partial<ReconciliationReportRowV1> = {}) =>
      row({
        sourceRow: 3,
        name: 'Pessoa Distinta',
        nameKey: 'PESSOA DISTINTA',
        inep: '999',
        inepKey: '999',
        enrollmentHash: 'synthetic-enrollment-b',
        ...overrides,
      });
    const twinSource = (overrides: Partial<ReconciliationSourceV1> = {}) =>
      source({
        sourceId: 'synthetic-origin-b',
        studentUid: twinStudent.studentUid,
        current: twinRow(),
        ...overrides,
      });
    const settled = [
      { sourceRow: 2, studentUid: student.studentUid, rule: 'continuity', reason: null },
      { sourceRow: 3, studentUid: twinStudent.studentUid, rule: 'continuity', reason: null },
    ];

    it('o mesmo relatório conserva os dois vínculos sem nova pendência', () => {
      const result = plan([row(), twinRow()], [source(), twinSource()], [student, twinStudent]);
      expect(result.rows).toMatchObject(settled);
    });
    it('a decisão de pessoas diferentes não torna pendente o vínculo de cada um', () => {
      const result = plan(
        [row(), twinRow()],
        [source(), twinSource()],
        [student, twinStudent],
        [
          { sourceId: 'synthetic-origin-a', studentUid: twinStudent.studentUid },
          { sourceId: 'synthetic-origin-b', studentUid: student.studentUid },
        ],
      );
      expect(result.rows).toMatchObject(settled);
    });
    it.each([false, true])(
      'conserva vínculos e rejeições com hashes novos; ordem reversa %s',
      (reverse) => {
        const changed = [row({ enrollmentHash: 'new-a' }), twinRow({ enrollmentHash: 'new-b' })];
        const result = plan(
          reverse ? [...changed].reverse() : changed,
          reverse ? [twinSource(), source()] : [source(), twinSource()],
          [student, twinStudent],
          [
            { sourceId: 'synthetic-origin-a', studentUid: twinStudent.studentUid },
            { sourceId: 'synthetic-origin-b', studentUid: student.studentUid },
          ],
        );
        expect(result.rows).toMatchObject(reverse ? [...settled].reverse() : settled);
        expect(result.profiles).toHaveLength(2);
      },
    );
    it('vale também quando estão em turmas diferentes', () => {
      const other = {
        classId: 8,
        classLabel: '7C 2026 - VESPERTINO',
        classKey: '7C 2026 - VESPERTINO',
      };
      const result = plan(
        [row(), twinRow(other)],
        [source(), twinSource({ current: twinRow(other) })],
        [student, { ...twinStudent, classId: 8 }],
      );
      expect(result.rows).toMatchObject(settled);
    });
    it('o primeiro encontro de um deles continua pedindo conferência', () => {
      const result = plan([row(), twinRow()], [source()], [student, twinStudent]);
      expect(result.rows[0]).toMatchObject({ studentUid: student.studentUid, rule: 'continuity' });
      expect(result.rows[1]).toMatchObject({ studentUid: null, reason: 'identity_conflict' });
    });
    it('a rejeição do próprio vínculo e a origem em revisão continuam bloqueando', () => {
      const rejected = plan(
        [row()],
        [source()],
        [student],
        [{ sourceId: 'synthetic-origin-a', studentUid: student.studentUid }],
      );
      expect(rejected.rows[0]).toMatchObject({ studentUid: null, reason: 'rejected' });
      const reviewed = plan(
        [row(), twinRow()],
        [source({ reviewRequired: true }), twinSource()],
        [student, twinStudent],
      );
      expect(reviewed.rows[0]).toMatchObject({ studentUid: null, reason: 'source_review' });
    });
  });
  it('Filiação 1 ou INEP vazio não vira concordância nem recupera dado antigo', () => {
    const cleared = row({ filiation1: null, filiation1Key: null, inep: null, inepKey: null });
    const result = plan([cleared], [source()]);
    expect(result.rows[0]?.rule).toBe('continuity');
    expect(result.profiles[0]?.selectedSourceRow).toBe(2);
    const unknown = { ...cleared, nameKey: 'OUTRO', enrollmentHash: 'new' };
    expect(plan([unknown], [source()]).rows[0]?.reason).toBe('no_match');
  });
  it('não fabrica perfil combinando matrículas com atributos opcionais conflitantes', () => {
    const result = plan([
      row(),
      row({ sourceRow: 3, enrollmentHash: 'other', filiation1: null, filiation1Key: null }),
    ]);
    expect(result.rows.every((item) => item.studentUid === student.studentUid)).toBe(true);
    expect(result.profiles[0]).toMatchObject({
      selectedSourceRow: null,
      reason: 'profile_conflict',
    });
  });
  it('rejeição persiste com hash alterado e evidência histórica, mas não proíbe nomes genericamente', () => {
    const separated = source({ studentUid: null });
    const pair = { sourceId: separated.sourceId, studentUid: student.studentUid };
    expect(
      plan([row({ enrollmentHash: 'changed' })], [separated], [student], [pair]).rows[0]?.reason,
    ).toBe('rejected');
    const changed = row({
      enrollmentHash: 'changed',
      inep: '999',
      inepKey: '999',
      filiation1: null,
      filiation1Key: null,
    });
    expect(plan([changed], [separated], [student], [pair]).rows[0]?.reason).toBe('rejected');
    const distinct = row({
      classId: 8,
      classKey: '8A 2026 - MATUTINO',
      birthDate: '2014-01-01',
      inep: '999',
      inepKey: '999',
      filiation1: 'Outra',
      filiation1Key: 'OUTRA',
      enrollmentHash: 'distinct',
    });
    const unrelated = { ...student, classId: 8, studentUid: 'unrelated-person' };
    expect(plan([distinct], [separated], [unrelated], [pair]).rows[0]?.studentUid).toBe(
      unrelated.studentUid,
    );
    expect(
      plan([row({ enrollmentHash: 'changed' })], [separated], [student], []).rows[0]?.studentUid,
    ).toBe(student.studentUid);
  });
  it('revisão de turma não valida vínculos silenciosamente', () => {
    const result = plan([row()], [source({ reviewRequired: true })]);
    expect(result.rows[0]).toMatchObject({
      sourceId: 'synthetic-origin-a',
      studentUid: null,
      reason: 'source_review',
    });
  });
  it('continuidade permite turma dividida mantendo a identidade sem alterar matrícula acadêmica', () => {
    const changed = row({
      classId: 8,
      classLabel: '7B 2026 - MATUTINO',
      classKey: '7B 2026 - MATUTINO',
    });
    expect(plan([changed], [source()]).rows[0]).toMatchObject({
      sourceId: 'synthetic-origin-a',
      studentUid: student.studentUid,
      rule: 'continuity',
    });
  });
  it('turma não ligada e pessoa externa sem par permanecem sem UID', () => {
    expect(plan([row({ classId: null })]).rows[0]?.reason).toBe('class_unlinked');
    expect(plan([row()], [], []).rows[0]?.reason).toBe('no_match');
  });
  it('ordem das linhas e das fontes não altera decisões ou digest e multiplicidade é preservada', () => {
    const rows = [row(), row({ sourceRow: 3, enrollmentHash: 'other' })];
    const forward = plan(rows);
    const reverse = plan([...rows].reverse());
    expect(reverse.rows).toEqual([...forward.rows].reverse());
    expect(reverse.profiles).toEqual(forward.profiles);
    expect(reportContentV1(rows)).toBe(reportContentV1([...rows].reverse()));
    expect(reportContentV1(rows)).not.toBe(reportContentV1([rows[0]!]));
    expect(reportContentV1([row()])).not.toBe(reportContentV1([row({ name: 'Aluna teste' })]));
  });
  it('fonte do nome não muda dados de identidade nem usa similaridade', () => {
    expect(adoptedStudentNameV1('relation', 'Maria Sintética', 'Marina Sintética')).toBe(
      'Maria Sintética',
    );
    expect(adoptedStudentNameV1('report', 'Maria Sintética', 'Marina Sintética')).toBe(
      'Marina Sintética',
    );
    expect(adoptedStudentNameV1('relation', null, 'Marina Sintética')).toBe('Marina Sintética');
    expect(adoptedStudentNameV1('report', 'Maria Sintética', null)).toBe('Maria Sintética');
    expect(plan([row({ nameKey: 'ALUNO TESTE' })]).rows[0]?.studentUid).toBeNull();
  });
});

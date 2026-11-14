import { SCHOOL_TIME_ZONE_V1 } from '../../../../shared/school-time-zone-v1';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { PerformanceAnalyticsV6 } from '../../../../shared/gradebook-contracts/performance/performance-analytics-v6';
import {
  analyticsPercentV6 as percent,
  analyticsGradeV6 as grade,
  analyticsDeltaV6 as delta,
  analyticsPeriodV6 as period,
} from './analytics-format-v6';

/** Explicit user export of the current authorized snapshot. No new query or academic calculation. */
export async function buildPerformanceTeacherPdfV6(
  value: PerformanceAnalyticsV6,
  teacherId: number,
  detailed: boolean,
): Promise<Uint8Array> {
  const teacher = value.teachers.find((item) => item.id === teacherId);
  if (!teacher) throw new Error('teacher-outside-current-scope');
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica),
    bold = await document.embedFont(StandardFonts.HelveticaBold);
  const allowed = new Set(regular.getCharacterSet());
  const safe = (text: string) =>
    [...text.replace(/[\r\n\t]+/gu, ' ')]
      .map((char) => (allowed.has(char.codePointAt(0)!) ? char : '?'))
      .join('');
  const accent = rgb(0.1, 0.26, 0.65),
    ink = rgb(0.13, 0.17, 0.24),
    muted = rgb(0.38, 0.43, 0.5),
    line = rgb(0.86, 0.88, 0.92);
  let page!: PDFPage,
    y = 0;
  const text = (
    content: string,
    x: number,
    baseline: number,
    size = 10,
    font = regular,
    color = ink,
  ) => page.drawText(safe(content), { x, y: baseline, size, font, color });
  const wrap = (
    content: string,
    width: number,
    size: number,
    font: PDFFont = regular,
  ): string[] => {
    const result: string[] = [];
    let current = '';
    for (const char of safe(content)) {
      if (font.widthOfTextAtSize(current + char, size) > width && current) {
        result.push(current.trim());
        current = '';
      }
      current += char;
    }
    if (current || !result.length) result.push(current.trim());
    return result;
  };
  const newPage = () => {
    page = document.addPage([595.28, 841.89]);
    page.drawRectangle({ x: 0, y: 827.89, width: 595.28, height: 14, color: accent });
    text('Desempenho · Professor', 40, 789, 21, bold, accent);
    const title = wrap(teacher.label, 515, 12, bold);
    title.forEach((part, index) => text(part, 40, 765 - index * 15, 12, bold));
    y = 737 - (title.length - 1) * 15;
    text(
      `${value.context.year} · ${value.classGroup.label} · ${period(value.period)} · ${detailed ? 'Detalhado' : 'Resumido'}`,
      40,
      y,
      10,
      regular,
      muted,
    );
    y -= 23;
    page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.6, color: line });
    y -= 25;
  };
  const ensure = (height: number) => {
    if (y - height < 63) newPage();
  };
  const heading = (title: string) => {
    ensure(45);
    text(title, 40, y, 12, bold);
    y -= 23;
  };
  function table(headers: string[], widths: number[], rows: string[][]) {
    const header = () => {
      ensure(42);
      let x = 40;
      page.drawRectangle({ x: 40, y: y - 9, width: 515, height: 27, color: rgb(0.94, 0.96, 0.99) });
      headers.forEach((title, index) => {
        text(title, x + 5, y, 8, bold, accent);
        x += widths[index]!;
      });
      y -= 27;
    };
    header();
    for (const row of rows) {
      const lines = row.map((cell, index) => wrap(cell, widths[index]! - 10, 8));
      const height = Math.max(...lines.map((cell) => cell.length)) * 11 + 9;
      if (y - height < 63) {
        newPage();
        header();
      }
      let x = 40;
      lines.forEach((parts, index) => {
        parts.forEach((part, lineIndex) => text(part, x + 5, y - lineIndex * 11, 8));
        x += widths[index]!;
      });
      y -= height;
      page.drawLine({
        start: { x: 40, y: y + 10 },
        end: { x: 555, y: y + 10 },
        thickness: 0.4,
        color: line,
      });
    }
    y -= 16;
  }
  newPage();
  const summary = teacher.summary;
  const kpis = [
    ['Aproveitamento', percent(summary.result.mean)],
    ['Alunos abaixo', `${summary.studentsBelow}/${summary.students}`],
    ['Notas lançadas', percent(summary.coverage.percent)],
    ['REC pendente', String(summary.recovery.pending)],
  ];
  kpis.forEach(([label, number], index) => {
    const x = 40 + index * 131;
    text(label!, x, y, 9, regular, muted);
    text(number!, x, y - 28, 22, bold, accent);
  });
  y -= 70;
  heading('Síntese');
  table(
    ['Mediana', 'Quantitativo', 'Qualitativo', 'Variação', 'Resultados'],
    [103, 103, 103, 113, 93],
    [
      [
        percent(summary.result.median),
        percent(summary.quantitative.mean),
        percent(summary.qualitative.mean),
        delta(summary.movement.meanDeltaPP),
        `${summary.complete}/${summary.readings}`,
      ],
    ],
  );
  heading('Trimestres');
  table(
    ['Período', 'Aproveitamento', 'Mediana', 'Resultados'],
    [100, 140, 140, 135],
    summary.timeline.map((item) => [
      `T${item.term}`,
      percent(item.mean),
      percent(item.median),
      String(item.n),
    ]),
  );
  heading('Componentes nesta turma');
  const components = value.components.filter((item) => teacher.offerIds.includes(item.offer.id));
  table(
    ['Componente', 'Aproveitamento', 'Abaixo', 'Resultados'],
    [260, 110, 65, 80],
    components.map((item) => [
      item.offer.subject.label,
      percent(item.summary.result.mean),
      String(item.summary.below),
      `${item.summary.complete}/${item.summary.readings}`,
    ]),
  );
  heading(detailed ? 'Acompanhamento dos alunos' : 'Alunos com resultados abaixo ou parciais');
  const students = new Map(value.students.map((item) => [item.student.id, item]));
  const selected = detailed
    ? teacher.students
    : teacher.students.filter((item) => item.below > 0 || item.partial > 0);
  table(
    ['Aluno', 'Aproveitamento', 'Abaixo', 'Resultados', 'Variação'],
    [225, 95, 50, 60, 85],
    selected.map((item) => [
      students.get(item.studentId)!.student.name,
      percent(item.meanPercent),
      String(item.below),
      String(item.complete),
      delta(item.deltaPP),
    ]),
  );
  if (detailed) {
    for (const component of components) {
      heading(`${component.offer.subject.label} · Instrumentos`);
      table(
        ['Instrumento', 'Média', 'Mediana', 'Lançados', 'Zeros'],
        [230, 80, 80, 75, 50],
        component.instruments.map((item) => [
          `T${item.term} · ${item.label}`,
          percent(item.stats.mean),
          percent(item.stats.median),
          `${item.coverage.recorded}/${item.coverage.expected}`,
          String(item.coverage.zeros),
        ]),
      );
      heading(`${component.offer.subject.label} · Notas`);
      table(
        ['Aluno', 'Nota / máx.', 'Quant.', 'Qual.', 'Até limite', 'REC'],
        [210, 75, 60, 60, 55, 55],
        value.students.map((item) => {
          const cell = item.cells.find((cell) => cell.offerId === component.offer.id)!;
          const recovery = {
            complete: 'Lançada',
            pending: 'Pendente',
            'no-show': 'N/C',
            'repeat-failure': 'R/R',
            'not-applicable': '—',
            unknown: '?',
          }[cell.recoveryState];
          return [
            item.student.name,
            `${grade(cell.result.valueMilli)}${cell.result.state === 'partial' ? '*' : ''} / ${grade(cell.result.maximumMilli)}`,
            percent(cell.quantitative.percent),
            percent(cell.qualitative.percent),
            grade(cell.gapMilli),
            recovery,
          ];
        }),
      );
    }
  }
  ensure(115);
  heading('Registro de ações');
  for (let i = 0; i < 3; i++) {
    page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.4, color: line });
    y -= 23;
  }
  const pages = document.getPages();
  const readAt = new Date(value.readAt).toLocaleString('pt-BR', { timeZone: SCHOOL_TIME_ZONE_V1 });
  for (const [index, current] of pages.entries()) {
    page = current;
    text(
      `Análise descritiva · ${readAt} · ${index + 1}/${pages.length}`,
      40,
      39,
      8,
      regular,
      muted,
    );
    text(
      'Estatísticas incluem resultados com instrumentos em branco. * Instrumento em branco. — Sem valor comparável. Não substitui resultado oficial.',
      40,
      25,
      7,
      regular,
      muted,
    );
  }
  document.setTitle('Desempenho pedagógico — relatório do professor');
  return document.save();
}
export async function downloadPerformanceTeacherReportV6(
  value: PerformanceAnalyticsV6,
  teacherId: number,
  detailed: boolean,
): Promise<void> {
  const bytes = await buildPerformanceTeacherPdfV6(value, teacherId, detailed);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `desempenho-${value.context.year}-turma-${value.classGroup.id}-professor-${teacherId}-${detailed ? 'detalhado' : 'resumido'}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

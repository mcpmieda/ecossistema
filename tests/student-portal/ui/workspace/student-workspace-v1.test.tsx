// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentPortalWorkspaceV1 } from '../../../../src/features/student-portal/workspace/student-workspace-v1';
import { gradesFixtureV1 } from '../grades/fixtures-v1';
import { setupOperationsDomV1 } from '../overview/dom-v1';

beforeEach(() => {
  setupOperationsDomV1();
  window.history.replaceState(null, '', window.location.href);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderWorkspace() {
  const data = gradesFixtureV1(false);
  render(
    <StudentPortalWorkspaceV1
      data={data}
      profile={<div data-testid="synthetic-profile">Perfil sintético</div>}
    />,
  );
  return data;
}

describe('student portal grade workspace', () => {
  it('keeps only Boletim and Disciplina in the main navigation', () => {
    renderWorkspace();
    const navigation = screen.getByRole('tablist', { name: 'Áreas do Portal do Aluno' });

    expect(within(navigation).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Boletim',
      'Disciplina',
    ]);
    expect(within(navigation).queryByRole('tab', { name: 'Resumo' })).toBeNull();
    expect(within(navigation).queryByRole('tab', { name: 'Evolução' })).toBeNull();
  });

  it('opens a discipline from Boletim without repeating the trimester after its title', async () => {
    const data = renderWorkspace();
    const user = userEvent.setup();
    const navigation = screen.getByRole('tablist', { name: 'Áreas do Portal do Aluno' });
    const first = [...data.subjects].sort((a, b) => a.order - b.order)[0]!;
    const option = screen.getByRole('option', { name: new RegExp(first.label, 'u') });

    expect(within(option).queryByText('1º Trimestre')).toBeNull();
    await user.click(option);

    expect(
      within(navigation).getByRole('tab', { name: 'Disciplina' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(screen.getByRole('heading', { name: first.label })).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    // The trimester mark is shown once, heading the partials card.
    expect(screen.getAllByText('Sua nota do 1º trimestre')).toHaveLength(1);
    expect(screen.getByText('Não foi muito bem')).toBeTruthy();
    // Only an official result earns a chip beside the title; this subject has none yet.
    expect(screen.queryByText('Resultado oficial:', { exact: false })).toBeNull();
  });

  it('labels discipline partials with the granular Não fez / Tirou zero rule', async () => {
    const data = gradesFixtureV1(true);
    const first = data.subjects.find((subject) => subject.order === 1)!;
    first.periods.find((p) => p.period === 'T1')!.partials![1] = {
      assessmentId: 900002,
      label: 'AV2 SYNTHETIC',
      notDone: true,
      mark: { kind: 'absent' },
    };
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    await userEvent.setup().click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));

    const partials = screen.getByRole('list', { name: 'Avaliações publicadas' });
    expect(within(partials).getAllByText('Não fez')).toHaveLength(1);
    expect(within(partials).getAllByText('Tirou zero')).toHaveLength(1);
    // Missing evidence stays neutral; it is never promoted to Não fez.
    expect(within(partials).getByLabelText('Ainda não lançado')).toBeTruthy();
  });

  it('tags each activity in four bands around the server minimum', async () => {
    const data = gradesFixtureV1(true);
    const first = data.subjects.find((subject) => subject.order === 1)!;
    const partials = first.periods.find((p) => p.period === 'T1')!.partials!;
    partials[1] = { assessmentId: 900002, label: 'AV2 SYNTHETIC', notDone: true, mark: { kind: 'absent' } };
    partials[6] = {
      assessmentId: 900009,
      label: 'Atividade abaixo',
      mark: { kind: 'score', value: 0.5, maximum: 2, meetsMinimum: false },
    };
    const band = (id: number, label: string, value: number, maximum: number, meetsMinimum: boolean) => ({
      assessmentId: id,
      label,
      mark: { kind: 'score' as const, value, maximum, meetsMinimum },
    });
    partials.push(
      band(900101, 'Faixa 40', 0.8, 2, false), // exactly 40%: Não foi muito bem
      band(900102, 'Faixa 79', 3.95, 5, true), // 79%: Foi bem
      band(900103, 'Faixa 80', 4, 5, true), // exactly 80%: Excelente
    );
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    await userEvent.setup().click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));

    const rows = within(screen.getByRole('list', { name: 'Avaliações publicadas' })).getAllByRole('listitem');
    const tag = (label: string) =>
      rows.find((item) => within(item).queryByText(label))!.querySelector('.pa-partial-feedback')?.textContent ?? null;
    expect(tag('Atividade abaixo')).toBe('Precisa melhorar'); // 25%
    expect(tag('Faixa 40')).toBe('Não foi muito bem');
    expect(tag('Faixa 79')).toBe('Foi bem');
    expect(tag('Faixa 80')).toBe('Excelente');
    expect(tag('I AVALIAÇÃO')).toBeNull(); // Tirou zero already says it
    expect(tag('AV2 SYNTHETIC')).toBeNull(); // Não fez already says it
    expect(tag('Atividade 3')).toBeNull(); // no maximum → no classification
    expect(tag('Atividade 2')).toBeNull(); // not yet recorded
  });

  it('marks a taken parallel exam as a second chance, and a pending one not at all', async () => {
    const data = gradesFixtureV1(true);
    const first = data.subjects.find((subject) => subject.order === 1)!;
    const partials = first.periods.find((p) => p.period === 'T1')!.partials!;
    partials.push(
      {
        assessmentId: 900201,
        label: 'PARALELA FEITA',
        parallel: true,
        mark: { kind: 'score', value: 7, maximum: 13.5, meetsMinimum: false },
      },
      { assessmentId: 900202, label: 'PARALELA PENDENTE', parallel: true, mark: { kind: 'absent' } },
    );
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    await userEvent.setup().click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));

    const rows = within(screen.getByRole('list', { name: 'Avaliações publicadas' })).getAllByRole('listitem');
    const row = (label: string) => rows.find((item) => within(item).queryByText(label))!;
    expect(within(row('PARALELA FEITA')).getByText('Foi uma segunda chance')).toBeTruthy();
    expect(within(row('PARALELA PENDENTE')).queryByText('Foi uma segunda chance')).toBeNull();
  });

  it('drags to the next or previous discipline, never on a tab bar or a vertical scroll', async () => {
    const data = gradesFixtureV1(false);
    const [first, second] = [...data.subjects].sort((a, b) => a.order - b.order) as [
      (typeof data.subjects)[number],
      (typeof data.subjects)[number],
    ];
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    await userEvent.setup().click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));
    // The content follows the finger (touchmove) and the move completes on release.
    const swipe = (target: Element, from: [number, number], to: [number, number]) => {
      fireEvent.touchStart(target, { touches: [{ clientX: from[0], clientY: from[1] }] });
      fireEvent.touchMove(target, { touches: [{ clientX: to[0], clientY: to[1] }] });
      fireEvent.touchEnd(target, { changedTouches: [{ clientX: to[0], clientY: to[1] }] });
    };
    const heading = () => screen.getByRole('heading', { level: 2, name: /Disciplina sintética/u }).textContent;

    // Right from the first discipline: nothing before it, no wrap.
    swipe(screen.getByText('Sua nota do 1º trimestre'), [100, 300], [260, 305]);
    expect(heading()).toBe(first.label);
    // Mostly vertical: a scroll, not a swipe.
    swipe(screen.getByText('Sua nota do 1º trimestre'), [260, 200], [150, 420]);
    expect(heading()).toBe(first.label);
    // On the subject bar, which scrolls sideways itself.
    swipe(screen.getByRole('tablist', { name: 'Trocar disciplina' }), [260, 150], [100, 150]);
    expect(heading()).toBe(first.label);

    // While dragging, the next discipline is already drawn beside this one (hidden from assistive tech).
    const card = screen.getByText('Sua nota do 1º trimestre');
    fireEvent.touchStart(card, { touches: [{ clientX: 260, clientY: 300 }] });
    fireEvent.touchMove(card, { touches: [{ clientX: 180, clientY: 302 }] });
    expect(document.querySelector('.pa-swipe-peek--next')?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.touchCancel(card);
    expect(document.querySelector('.pa-swipe-peek')).toBeNull();
    expect(heading()).toBe(first.label);

    swipe(screen.getByText('Sua nota do 1º trimestre'), [260, 300], [100, 305]);
    expect(heading()).toBe(second.label);
    swipe(screen.getByText('Sua nota do 1º trimestre'), [100, 300], [260, 305]);
    expect(heading()).toBe(first.label);
  });

  it('drags the Boletim between trimesters without opening the subject under the finger', () => {
    const data = gradesFixtureV1(false);
    for (const subject of data.subjects)
      subject.periods = [
        { period: 'T1', final: { kind: 'score', value: 20, maximum: 30, meetsMinimum: true } },
        { period: 'T2', final: { kind: 'score', value: 21, maximum: 30, meetsMinimum: true } },
      ];
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    const selectedPeriod = () =>
      within(screen.getByRole('tablist', { name: 'Período das notas' }))
        .getAllByRole('tab')
        .find((tab) => tab.getAttribute('aria-selected') === 'true')!.textContent;
    const row = () => screen.getAllByRole('option')[0]!;
    const drag = (from: number, to: number) => {
      fireEvent.touchStart(row(), { touches: [{ clientX: from, clientY: 300 }] });
      fireEvent.touchMove(row(), { touches: [{ clientX: to, clientY: 302 }] });
      fireEvent.touchEnd(row(), { changedTouches: [{ clientX: to, clientY: 302 }] });
      // The browser's tap that follows the release is swallowed: the Boletim stays open.
      fireEvent.click(row());
    };
    expect(selectedPeriod()).toContain('1º Trimestre');
    drag(260, 100);
    expect(selectedPeriod()).toContain('2º Trimestre');
    expect(screen.getByRole('tablist', { name: 'Período das notas' })).toBeTruthy();
    // Past the last trimester the list only gives a little and comes back.
    drag(260, 100);
    expect(selectedPeriod()).toContain('2º Trimestre');
    drag(100, 260);
    expect(selectedPeriod()).toContain('1º Trimestre');
  });

  it('keeps the chosen trimester across subjects, the Boletim tab on return and a reload', async () => {
    const data = gradesFixtureV1(false);
    const subjects = [...data.subjects].sort((a, b) => a.order - b.order);
    for (const subject of subjects.slice(0, 2)) {
      subject.periods = [
        { period: 'T1', final: { kind: 'score', value: 20, maximum: 30, meetsMinimum: true } },
        { period: 'T2', final: { kind: 'score', value: 21, maximum: 30, meetsMinimum: true } },
      ];
    }
    const [first, second] = subjects as [(typeof subjects)[number], (typeof subjects)[number]];
    const view = render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    const user = userEvent.setup();
    const selected = (name: string) =>
      within(screen.getByRole('tablist', { name })).getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')!
        .textContent;

    await user.click(screen.getByRole('tab', { name: /^2º Trimestre/u }));
    await user.click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));
    expect(selected('Períodos de ' + first.label)).toContain('2º Trimestre');

    await user.click(within(screen.getByRole('tablist', { name: 'Trocar disciplina' })).getByRole('tab', { name: second.label }));
    expect(selected('Períodos de ' + second.label)).toContain('2º Trimestre');

    await user.click(screen.getByRole('button', { name: 'Voltar para o boletim' }));
    expect(selected('Período das notas')).toContain('2º Trimestre');

    // A reload restores the same place from the history entry.
    await user.click(screen.getByRole('option', { name: new RegExp(second.label, 'u') }));
    view.unmount();
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    await act(async () => {});
    expect(selected('Períodos de ' + second.label)).toContain('2º Trimestre');
  });

  it('clamps an overflowing activity description to two lines and reveals it on demand', async () => {
    // jsdom has no layout: report every clamped description as overflowing.
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('pa-partial-label') && !this.classList.contains('is-expanded') ? 80 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 40);
    const data = gradesFixtureV1(true);
    const first = data.subjects.find((subject) => subject.order === 1)!;
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));

    const long = screen.getByText(/Atividade com descrição oficial extensa/u);
    expect(long.classList.contains('is-expanded')).toBe(false);
    const toggle = within(long.parentElement!).getByRole('button', { name: 'Ver tudo' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    expect(long.classList.contains('is-expanded')).toBe(true);
    // The full text was always in the DOM; the toggle only changes how much is visible.
    expect(long.textContent).toContain('situação de aprendizagem');
    expect(within(long.parentElement!).getByRole('button', { name: 'Ver menos' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the trimester trend by percentage, never on T1 or against a non-numeric mark', async () => {
    const data = gradesFixtureV1(false);
    const first = data.subjects.find((subject) => subject.order === 1)!;
    const scoreOf = (value: number, maximum: number) =>
      ({ kind: 'score', value, maximum, meetsMinimum: true }) as const;
    first.periods = [
      { period: 'T1', final: scoreOf(18, 30) },
      { period: 'T2', final: scoreOf(21, 30) },
      // 26 > 21 in raw points, but 65% < 70%: the trend must be "down".
      { period: 'T3', final: scoreOf(26, 40) },
      { period: 'REC1', final: { kind: 'recovery-pending' } },
    ];
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));
    const periods = screen.getByRole('tablist', { name: 'Períodos de ' + first.label });

    // The trend is a plain line under the status (option C, 27/09/2026), no button or tooltip.
    expect(screen.queryByText(/em relação ao/u)).toBeNull();
    await user.click(within(periods).getAllByRole('tab')[1]!);
    expect(screen.getByText('Subiu em relação ao 1º')).toBeTruthy();
    await user.click(within(periods).getAllByRole('tab')[2]!);
    // Still above the minimum, so the drop reads "Porém caiu".
    expect(screen.getByText('Porém caiu em relação ao 2º')).toBeTruthy();
    await user.click(within(periods).getAllByRole('tab')[3]!);
    expect(screen.queryByText(/em relação ao/u)).toBeNull();
  });

  it('omits the breakdown when the admin withholds partials, but says so when none exist', async () => {
    const data = gradesFixtureV1(false); // no `partials` key: showPartials off
    const first = data.subjects.find((subject) => subject.order === 1)!;
    const { unmount } = render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    await userEvent.setup().click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));
    expect(screen.queryByText('Como o aluno foi em cada atividade')).toBeNull();
    expect(screen.queryByText('Nenhuma avaliação parcial publicada.')).toBeNull();
    unmount();
    window.history.replaceState(null, '', window.location.href);

    first.periods.find((p) => p.period === 'T1')!.partials = [];
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    await userEvent.setup().click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));
    expect(screen.getByText('Nenhuma avaliação parcial publicada.')).toBeTruthy();
  });

  it('shows a Recuperação tab only for released recoveries and opens the discipline on it', async () => {
    const data = renderWorkspace();
    const user = userEvent.setup();
    const periods = screen.getByRole('tablist', { name: 'Período das notas' });
    await user.click(within(periods).getByRole('tab', { name: 'Recuperação' }));

    const withRecovery = data.subjects.filter((subject) =>
      subject.periods.some((period) => period.period.startsWith('REC')),
    );
    const list = screen.getByRole('listbox', { name: 'Disciplinas publicadas' });
    expect(within(list).getAllByRole('option')).toHaveLength(withRecovery.length);

    const pending = withRecovery.find((subject) =>
      subject.periods.some((period) => period.final.kind === 'recovery-pending'),
    )!;
    await user.click(within(list).getByRole('option', { name: new RegExp(pending.label, 'u') }));
    expect(screen.getByText('Recuperação do 1º trimestre')).toBeTruthy();
    expect(screen.getByText('Aguardando nota')).toBeTruthy();
    cleanup();

    const withoutRecovery = gradesFixtureV1(false);
    for (const subject of withoutRecovery.subjects)
      subject.periods = subject.periods.filter((period) => !period.period.startsWith('REC'));
    render(<StudentPortalWorkspaceV1 data={withoutRecovery} profile={null} />);
    expect(screen.queryByRole('tab', { name: 'Recuperação' })).toBeNull();
  });

  it('shows the final result only when the server sends a released outcome', () => {
    const data = gradesFixtureV1(false);
    const { unmount } = render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    expect(screen.queryByText(/Resultado final/u)).toBeNull();
    unmount();

    data.profile.result = 'failed-attendance';
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    expect(screen.getByText('Resultado final 2026')).toBeTruthy();
    expect(screen.getByText('Reprovado por falta')).toBeTruthy();
  });

  it('shows EM RECUPERAÇÃO with its subjects and the official wording of final situations', () => {
    const data = gradesFixtureV1(false);
    const [first, second] = [...data.subjects].sort((a, b) => a.order - b.order);
    data.profile.annualSituation = 'in-recovery';
    first!.annualSituation = 'recovery-pending';
    second!.annualSituation = 'recovery-pending';
    const { unmount } = render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    expect(screen.getByText('Situação 2026')).toBeTruthy();
    expect(screen.getByText(`Recuperação em ${first!.label}, ${second!.label}`)).toBeTruthy();
    expect(screen.getAllByText('Em recuperação').length).toBeGreaterThanOrEqual(3);
    unmount();

    data.profile.result = 'approved';
    data.profile.annualSituation = 'approved-after-recovery';
    first!.annualSituation = 'approved-after-recovery';
    delete second!.annualSituation;
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    expect(screen.getByText('Resultado final 2026')).toBeTruthy();
    expect(screen.getAllByText('Aprovado pela recuperação')).toHaveLength(2);
  });

  it('shows the Meta do ano only on the 2º tri tab, from marks already on screen', async () => {
    const data = gradesFixtureV1(false);
    const first = data.subjects.find((subject) => subject.order === 1)!;
    const scoreOf = (value: number, maximum: number) =>
      ({ kind: 'score', value, maximum, meetsMinimum: true }) as const;
    first.periods = [
      { period: 'T1', final: scoreOf(18.5, 30) },
      { period: 'T2', final: scoreOf(17.3, 30) },
      { period: 'T3', final: { kind: 'absent' } },
    ];
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));
    const periods = screen.getByRole('tablist', { name: 'Períodos de ' + first.label });

    expect(screen.queryByRole('heading', { name: /Faltam/u })).toBeNull();
    await user.click(within(periods).getAllByRole('tab')[1]!);
    // 60 − (18,5 + 17,3) = 24,2 in the 3º tri.
    expect(screen.getByRole('heading', { name: 'Faltam 24,2 pontos' })).toBeTruthy();
    expect(screen.getByText(/para fechar o ano em /u)).toBeTruthy();
    expect(screen.queryByText(/2º tri:/u)).toBeNull();
    await user.click(within(periods).getAllByRole('tab')[2]!);
    expect(screen.queryByRole('heading', { name: /Faltam/u })).toBeNull();
  });

  it('animates the discipline icon with its own motion when the discipline opens', async () => {
    const data = gradesFixtureV1(false);
    const first = data.subjects.find((subject) => subject.order === 1)!;
    first.label = 'GEOGRAFIA';
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    const list = screen.getByRole('listbox', { name: 'Disciplinas publicadas' });
    expect(list.querySelector('.pa-subject-icon--animated')).toBeNull();

    await userEvent.setup().click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));
    const icon = document.querySelector('.pa-workspace-intro .pa-subject-icon--animated');
    expect(icon?.getAttribute('data-motion')).toBe('spin');
  });

  it('restores Boletim with browser back after opening a discipline', async () => {
    const data = renderWorkspace();
    const user = userEvent.setup();
    const first = [...data.subjects].sort((a, b) => a.order - b.order)[0]!;
    const navigation = screen.getByRole('tablist', { name: 'Áreas do Portal do Aluno' });

    await user.click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));
    expect(within(navigation).getByRole('tab', { name: 'Disciplina' }).getAttribute('aria-selected'))
      .toBe('true');

    const state = {
      ...(window.history.state ?? {}),
      __studentPortalWorkspaceV1: { area: 'summary', subjectId: first.subjectId },
    };
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state }));
    });

    expect(within(navigation).getByRole('tab', { name: 'Boletim' }).getAttribute('aria-selected'))
      .toBe('true');
  });
});

describe('Relatório do trimestre summary on the Boletim', () => {
  const summary = (period: 'T1' | 'T2') => ({
    period,
    mode: 'conclusion' as const,
    message: { code: 'summary.all-good' as const, variant: 0 },
    attentionSubjectIds: [] as number[],
  });
  const withT2 = () => {
    const data = gradesFixtureV1(false);
    const first = data.subjects.find((subject) => subject.order === 1)!;
    first.periods = [
      { period: 'T1', final: { kind: 'score', value: 20, maximum: 30, meetsMinimum: true } },
      { period: 'T2', final: { kind: 'score', value: 21, maximum: 30, meetsMinimum: true } },
    ];
    return data;
  };

  it('shows a trimester summary only on its own tab', async () => {
    const data = { ...withT2(), closingSummary: summary('T2') };
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    expect(screen.queryByText(/Relatório do 2º trimestre/u)).toBeNull();
    await userEvent.setup().click(screen.getByRole('tab', { name: /^2º Trimestre/u }));
    expect(await screen.findByText(/Relatório do 2º trimestre/u)).toBeTruthy();
  });

  it('uses the per-trimester summaries when the server sends them', async () => {
    const data = { ...withT2(), closingSummary: summary('T2'), closingSummaries: [summary('T1'), summary('T2')] };
    render(<StudentPortalWorkspaceV1 data={data} profile={null} />);
    expect(screen.getByText(/Relatório do 1º trimestre/u)).toBeTruthy();
    expect(screen.queryByText(/Relatório do 2º trimestre/u)).toBeNull();
  });
});

it('goes back to the Boletim from the arrow beside the discipline icon', async () => {
  const data = renderWorkspace();
  const user = userEvent.setup();
  const first = [...data.subjects].sort((a, b) => a.order - b.order)[0]!;
  const navigation = screen.getByRole('tablist', { name: 'Áreas do Portal do Aluno' });
  await user.click(screen.getByRole('option', { name: new RegExp(first.label, 'u') }));
  await user.click(screen.getByRole('button', { name: 'Voltar para o boletim' }));
  expect(within(navigation).getByRole('tab', { name: 'Boletim' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('heading', { name: 'Minhas notas' })).toBeTruthy();
});

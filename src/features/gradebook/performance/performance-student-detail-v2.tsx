import { useEffect, useRef } from 'react';
import { Button, Drawer, Table } from '@heroui/react';
import { LinkedStudentPhotoAvatarV1 } from '../../student-photos/linked-student-photo-avatar-v1';
import '../../student-portal-admin/shared/student-avatar-v1.css';
import type {
  PerformancePeriodV2,
  PerformanceReadyV2,
} from '../../../../shared/gradebook-contracts/performance/relational-performance-v2';
import { GranularStatusV1 } from '../../../shared/grades/granular-status-v1';
import { GradeValue, gradeText } from './performance-display-v2';

type Detail = Extract<PerformanceReadyV2, { operation: 'student-detail' | 'cell-detail' }>;
export function PerformanceStudentDetailV2({
  detail,
  focusPeriod,
  openComponent,
}: {
  readonly detail: Detail;
  readonly focusPeriod: PerformancePeriodV2;
  /** `term` asks the breakdown to open on that trimester instead of the period in view. */
  readonly openComponent: (studentId: number, offerId: number, term?: 1 | 2 | 3) => void;
}) {
  const drawerBody = useRef<HTMLDivElement | null>(null);
  const focusedTerm = useRef<HTMLElement | null>(null);
  const focusSpacer = useRef<HTMLDivElement | null>(null);
  const student = detail.operation === 'student-detail' ? detail.row.student : detail.student;
  const visibleTerms =
    detail.operation === 'student-detail'
      ? ([0, 1, 2] as const).filter((index) =>
          detail.trajectory.some((offering) => offering.terms[index].valueMilli !== null),
        )
      : [];
  const operation = detail.operation;
  const offerId = detail.operation === 'cell-detail' ? detail.offer.id : null;
  useEffect(() => {
    if (operation !== 'cell-detail' || focusPeriod === 'annual') return;
    let settledFrame = 0;
    const mountedFrame = window.requestAnimationFrame(() => {
      settledFrame = window.requestAnimationFrame(() => {
        const body = drawerBody.current;
        const target = focusedTerm.current;
        const spacer = focusSpacer.current;
        if (body !== null && target !== null && spacer !== null) {
          spacer.style.height = '0px';
          const desiredScrollTop =
            body.scrollTop +
            target.getBoundingClientRect().top -
            body.getBoundingClientRect().top -
            20;
          const availableScrollTop = body.scrollHeight - body.clientHeight;
          spacer.style.height = `${Math.max(0, desiredScrollTop - availableScrollTop)}px`;
        }
        target?.scrollIntoView?.({ behavior: 'auto', block: 'start' });
      });
    });
    return () => {
      window.cancelAnimationFrame(mountedFrame);
      window.cancelAnimationFrame(settledFrame);
      if (focusSpacer.current !== null) focusSpacer.current.style.height = '0px';
    };
  }, [operation, student.id, offerId, focusPeriod]);
  return (
    <>
      <Drawer.Header className="border-b border-separator pb-5 pr-10">
        <div className="flex min-w-0 items-center gap-4">
          <LinkedStudentPhotoAvatarV1
            decorative
            size="lg"
            className="pa-student-avatar size-16 shrink-0"
            fallbackTone={student.id % 6}
            subject={{
              source: 'gradebook',
              academicYear: detail.context.year,
              studentIds: [student.id],
            }}
          />
          <div className="min-w-0">
            <Drawer.Heading className="break-words text-2xl font-bold tracking-tight">
              {student.name}
            </Drawer.Heading>
            <p className="mt-1 text-lg font-semibold">
              {detail.classGroup.name ?? detail.classGroup.label}
            </p>
            {detail.operation === 'cell-detail' ? (
              <p className="mt-1 text-sm">
                {detail.offer.subject.label} · {detail.offer.teacher.label}
              </p>
            ) : null}
            <p className="mt-1 text-xs text-muted">
              Atualizado em {new Date(detail.readAt).toLocaleDateString('pt-BR')}
            </p>
          </div>
        </div>
        {/* The photo is only changed on the student's record in Painel do Aluno (owner request
            12/11/2026); the Banco de notas shows it. */}
      </Drawer.Header>
      <Drawer.Body ref={drawerBody} className="flex min-w-0 flex-col gap-5 pt-5">
        {detail.operation === 'student-detail' ? (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
              <span>Nº {student.number}</span>
              {student.status !== null ? <span>{student.statusLabel}</span> : null}
            </div>
            {detail.row.formalCouncilDecision ? (
              <p className="text-sm font-medium">{detail.row.formalCouncilDecision.label}</p>
            ) : null}
            {visibleTerms.length ? (
              <Table className="performance-detail-table">
                <Table.ScrollContainer>
                  <Table.Content aria-label="Notas do aluno por trimestre">
                    <Table.Header>
                      <Table.Column id="component" isRowHeader>
                        Componente
                      </Table.Column>
                      {visibleTerms.map((index) => (
                        <Table.Column key={index} id={`term-${index}`}>
                          {index + 1}º{' '}
                          <span className="performance-detail-table__long">trimestre</span>
                          <span className="performance-detail-table__short" aria-hidden="true">
                            tri
                          </span>
                        </Table.Column>
                      ))}
                    </Table.Header>
                    <Table.Body>
                      {detail.trajectory.map((offering, index) => (
                        <Table.Row id={offering.offerId} key={offering.offerId}>
                          <Table.Cell>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-auto whitespace-normal text-left"
                              onPress={() => openComponent(student.id, offering.offerId)}
                            >
                              {detail.offers[index]!.subject.label}
                            </Button>
                          </Table.Cell>
                          {visibleTerms.map((term) => (
                            <Table.Cell key={term}>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-auto min-h-8 min-w-0 px-1 py-0.5"
                                aria-label={`${detail.offers[index]!.subject.label}, ${term + 1}º trimestre`}
                                onPress={() =>
                                  openComponent(
                                    student.id,
                                    offering.offerId,
                                    (term + 1) as 1 | 2 | 3,
                                  )
                                }
                              >
                                <GradeValue cell={offering.terms[term]} />
                              </Button>
                            </Table.Cell>
                          ))}
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            ) : (
              <p className="text-sm text-muted">Nenhuma nota lançada.</p>
            )}
          </>
        ) : (
          <>
            {detail.terms
              .filter(
                (term) =>
                  term.hasGrades ??
                  (term.instruments.some(
                    (value) => value.valueMilli !== null || value.notDone === true,
                  ) ||
                    term.regular.valueMilli !== null ||
                    term.recovery.valueMilli !== null ||
                    term.recovery.state === 'no-show' ||
                    term.recovery.state === 'repeat-failure'),
              )
              .map((term) => {
                const instruments = term.instruments.filter(
                  (instrument) => instrument.slot !== 3 || term.showParallel === true,
                );
                return (
                  <section
                    key={term.term}
                    aria-label={`${term.term}º trimestre`}
                    ref={(element) => {
                      if (term.term === focusPeriod) focusedTerm.current = element;
                    }}
                    className="scroll-mt-5 rounded-xl border border-separator p-4"
                  >
                    <div className="mb-4 flex items-center justify-between gap-4">
                      <h3 className="text-lg font-semibold">{term.term}º trimestre</h3>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted">Nota do trimestre</span>
                        <GradeValue cell={term.regular} prominent />
                      </div>
                    </div>
                    <Table>
                      <Table.Content aria-label={`Avaliações do ${term.term}º trimestre`}>
                        <Table.Header>
                          <Table.Column id="activity" isRowHeader>
                            Avaliação / atividade
                          </Table.Column>
                          <Table.Column id="grade">Nota</Table.Column>
                          <Table.Column id="maximum">Máximo</Table.Column>
                        </Table.Header>
                        <Table.Body>
                          {instruments.map((instrument) => (
                            <Table.Row key={instrument.slot} id={instrument.slot}>
                              <Table.Cell>{instrument.label}</Table.Cell>
                              <Table.Cell className="font-medium tabular-nums">
                                {instrument.notDone || instrument.valueMilli === 0 ? (
                                  <GranularStatusV1
                                    notDone={instrument.notDone}
                                    zero={instrument.valueMilli === 0}
                                  />
                                ) : (
                                  gradeText(instrument.valueMilli)
                                )}
                              </Table.Cell>
                              <Table.Cell className="tabular-nums text-muted">
                                {gradeText(instrument.maximumMilli)}
                              </Table.Cell>
                            </Table.Row>
                          ))}
                        </Table.Body>
                      </Table.Content>
                    </Table>
                    {term.showRecovery === true ? (
                      <div className="mt-4 flex items-center justify-between border-t border-separator pt-3">
                        <span className="text-sm font-medium">Recuperação final</span>
                        <GradeValue cell={term.recovery} />
                      </div>
                    ) : null}
                  </section>
                );
              })}
            {!detail.terms.some(
              (term) =>
                term.hasGrades ??
                term.instruments.some(
                  (value) => value.valueMilli !== null || value.notDone === true,
                ),
            ) ? (
              <p className="text-sm text-muted">Nenhuma nota lançada.</p>
            ) : null}
          </>
        )}
        <div ref={focusSpacer} aria-hidden="true" className="shrink-0" />
      </Drawer.Body>
    </>
  );
}

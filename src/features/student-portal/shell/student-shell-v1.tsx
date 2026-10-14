import { useId, useRef, useState, type ReactNode } from 'react';
import { Alert } from '@heroui/react/alert';
import { Button } from '@heroui/react/button';
import { Card } from '@heroui/react/card';
import { Chip } from '@heroui/react/chip';
import { Skeleton } from '@heroui/react/skeleton';
import { GraduationCap, LogOut, Star } from 'lucide-react';
import type { SelfResponseV1 } from '../../../../shared/student-portal-contracts/self-v1';
import type { PortalLoadStateV1 } from '../shared/latest-request-v1';
import { StudentPortalWorkspaceV1 } from '../workspace/student-workspace-v1';
import { brilliantSealCountV1 } from '../grades/brilliant-seal-v1';
import { SCHOOL_NAME_V1 } from '../../../shared/brand/school-mark-v1';
import './student-shell-v1.css';
import { StudentFrequencyV2 } from '../frequency/student-frequency-v2';
import type { StudentFrequencyClientV2 } from '../frequency/client-v2';

export const STUDENT_SCHOOL_NAME_V1 = SCHOOL_NAME_V1;
const outcome = {
  'in-progress': { label: 'Em curso', color: 'default' },
  approved: { label: 'Aprovado', color: 'success' },
  failed: { label: 'Reprovado', color: 'danger' },
  'failed-attendance': { label: 'Reprovado por falta', color: 'danger' },
  'not-applicable': { label: 'Não se aplica', color: 'default' },
} as const;

export interface StudentShellPropsV1 {
  children: ReactNode;
  schoolName?: string;
  logo?: ReactNode;
  onLogout?: () => void;
  loggingOut?: boolean;
  busy?: boolean;
  hero?: ReactNode;
}

/** Presentational shell: no routing, identity provider, requests or persistent student data. */
export function StudentPortalShellV1({
  children,
  schoolName = STUDENT_SCHOOL_NAME_V1,
  logo,
  onLogout,
  loggingOut = false,
  busy = false,
  hero,
}: StudentShellPropsV1) {
  const contentId = useId();
  const content = useRef<HTMLElement>(null);
  return (
    <div className={hero ? 'pa-shell pa-shell--with-hero' : 'pa-shell'}>
      <a
        className="pa-skip-link"
        href={'#' + contentId}
        onClick={(event) => {
          // Fragment navigation triggers popstate and the session's security revalidation.
          event.preventDefault();
          content.current?.focus();
        }}
      >
        Ir para o conteúdo
      </a>
      {hero ?? (
        <header className="pa-shell-header">
          <div className="pa-header-inner">
            <div className="pa-school-mark" role="img" aria-label={schoolName}>
              {logo ?? <span className="pa-school-logo-image" aria-hidden="true" />}
            </div>
            <div className="pa-header-title">
              <h1>PORTAL DO ALUNO</h1>
              <p>{schoolName}</p>
            </div>
            <div className="pa-header-action">
              {onLogout ? (
                <Button
                  size="sm"
                  variant="tertiary"
                  onPress={onLogout}
                  isDisabled={loggingOut}
                  aria-busy={loggingOut}
                >
                  Sair
                </Button>
              ) : null}
            </div>
          </div>
        </header>
      )}
      <main
        ref={content}
        id={contentId}
        className="pa-shell-content"
        tabIndex={-1}
        aria-busy={busy}
      >
        {children}
      </main>
    </div>
  );
}

/**
 * Long names get a smaller type size instead of piling up lines in the hero. Measured in
 * characters (not words) because uppercase official names vary widely in width.
 */
function nameLengthV1(name: string): 'regular' | 'long' | 'xlong' {
  const length = Array.from(name.trim()).length;
  return length > 34 ? 'xlong' : length > 22 ? 'long' : 'regular';
}

/**
 * "★ 2 selos brilhantes" in the hero. With none, the same pill shows "0 selos brilhantes", dimmed
 * and without shine (owner request 29/09/2026).
 */
function SealCountV1({ count }: { count: number }) {
  const empty = count <= 0;
  return (
    <span className={empty ? 'pa-seal-count pa-seal-count--empty' : 'pa-seal-count'}>
      <Star size={12} strokeWidth={2} fill={empty ? 'none' : 'currentColor'} aria-hidden="true" />
      {/* One text run, so the flex gap never adds a second space before "brilhante". */}
      <span>
        {Math.max(0, count)} {count === 1 ? 'selo brilhante' : 'selos brilhantes'}
      </span>
    </span>
  );
}

export function StudentProfileV1({
  profile,
  schoolName = STUDENT_SCHOOL_NAME_V1,
  logo,
  onLogout,
  loggingOut = false,
  portraitSrc,
  seals = 0,
}: {
  profile: SelfResponseV1['profile'];
  schoolName?: string;
  logo?: ReactNode;
  onLogout?: () => void;
  loggingOut?: boolean;
  /**
   * The student's original 3×4 photo (background included, no cutout), shown in the arch.
   * Must be same-origin (CSP img-src 'self'). Absent or failing to load → no portrait at all.
   */
  portraitSrc?: string;
  /** Selos brilhantes collected this year (see grades/brilliant-seal-v1.ts). */
  seals?: number;
}) {
  const heading = useId();
  const [failedSrc, setFailedSrc] = useState<string>();
  const photo = portraitSrc && portraitSrc !== failedSrc ? portraitSrc : undefined;
  const status =
    profile.academicState === 'assisted'
      ? { label: 'ASSISTIDO', color: 'accent' as const }
      : outcome[profile.result];

  return (
    <header
      className={
        photo ? 'pa-student-hero pa-student-hero--arch' : 'pa-student-hero pa-student-hero--no-portrait'
      }
      aria-labelledby={heading}
    >
      <h2 id={heading} className="pa-visually-hidden">
        Perfil do aluno
      </h2>
      <div className="pa-hero-inner">
        <div className="pa-hero-topbar">
          <div className="pa-hero-brand">
            <div className="pa-hero-brand-mark" role="img" aria-label={schoolName}>
              {logo ?? <span className="pa-school-logo-image" aria-hidden="true" />}
            </div>
            <div className="pa-hero-brand-copy">
              <h1>Portal do Aluno</h1>
              <p className="pa-hero-brand-school">{schoolName}</p>
            </div>
          </div>

          {onLogout ? (
            <Button
              isIconOnly
              size="sm"
              variant="tertiary"
              className="pa-hero-action"
              aria-label="Sair"
              onPress={onLogout}
              isDisabled={loggingOut}
              aria-busy={loggingOut}
            >
              <LogOut size={18} aria-hidden="true" />
            </Button>
          ) : null}
        </div>

        <div className="pa-hero-body">
          <div className="pa-hero-copy">
            <p className="pa-hero-greeting">Olá,</p>
            <h3 className={'pa-student-name pa-student-name--' + nameLengthV1(profile.name)} title={profile.name}>
              {profile.name}
            </h3>

            <div className="pa-hero-details">
              <p>
                <GraduationCap size={21} aria-hidden="true" />
                <span>{profile.classLabel}</span>
              </p>
            </div>

            {/* "Em curso" is not shown: it tells the student nothing (owner review 27/09/2026).
                An official status (Aprovado, Em recuperação…) still is, after the seals. */}
            <div className="pa-profile-meta">
              <SealCountV1 count={seals} />
              {status.label !== outcome['in-progress'].label ? (
                <Chip size="sm" variant="soft" color={status.color}>
                  {status.label}
                </Chip>
              ) : null}
            </div>
          </div>

          {/* The original 3×4 photo in an arch taken from the cover geometry. No photo, or one
              that fails to load, means no portrait and no placeholder: the copy keeps the space. */}
          {photo ? (
            <div className="pa-hero-portrait pa-hero-portrait--arch">
              <div className="pa-hero-frame">
                <img
                  className="pa-hero-frame-photo"
                  src={photo}
                  alt=""
                  aria-hidden="true"
                  onError={() => setFailedSrc(photo)}
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

export type StudentMessageKindV1 = 'empty' | 'error' | 'expired' | 'closed' | 'maintenance' | 'unavailable';
const messages = {
  empty: { title: 'Notas ainda não publicadas', description: '', status: 'default', action: '' },
  closed: { title: 'Acesso ao Portal fechado', description: '', status: 'warning', action: 'Tentar novamente' },
  error: {
    title: 'Não foi possível carregar seus dados',
    description: '',
    status: 'danger',
    action: 'Tentar novamente',
  },
  expired: {
    title: 'Sessão expirada',
    description: 'Entre novamente para continuar.',
    status: 'warning',
    action: 'Entrar',
  },
  maintenance: {
    title: 'Portal em manutenção',
    description: 'Tente novamente mais tarde.',
    status: 'warning',
    action: 'Tentar novamente',
  },
  unavailable: {
    title: 'Portal temporariamente indisponível',
    description: '',
    status: 'warning',
    action: 'Tentar novamente',
  },
} as const;

export function StudentPortalMessageV1({
  kind,
  onAction,
}: {
  kind: StudentMessageKindV1;
  onAction?: () => void;
}) {
  const message = messages[kind];
  if (kind === 'empty')
    return (
      <Card className="pa-empty-card">
        <Card.Content>
          <p role="status">{message.title}</p>
        </Card.Content>
      </Card>
    );
  return (
    <Alert status={message.status} className="pa-shell-alert" role="alert">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{message.title}</Alert.Title>
        {message.description ? <Alert.Description>{message.description}</Alert.Description> : null}
        {onAction ? (
          <Button size="sm" variant="secondary" className="pa-state-action" onPress={onAction}>
            {message.action}
          </Button>
        ) : null}
      </Alert.Content>
    </Alert>
  );
}

function StudentPageSkeletonV1() {
  return (
    <div className="pa-page-skeleton" role="status" aria-label="Carregando perfil e notas">
      <h2 className="pa-section-title">Perfil do aluno</h2>
      <Card className="pa-profile-card">
        <Card.Content className="pa-profile-content" aria-hidden="true">
          <Skeleton className="pa-skeleton-avatar" />
          <div className="pa-profile-identity pa-skeleton-lines">
            <Skeleton className="pa-skeleton-name" />
            <Skeleton className="pa-skeleton-class" />
            <Skeleton className="pa-skeleton-chip" />
          </div>
        </Card.Content>
      </Card>
      <h2 className="pa-section-title pa-grades-title">Minhas notas</h2>
      <Card className="pa-skeleton-grades" aria-hidden="true">
        <Card.Content>
          {[0, 1, 2, 3].map((row) => (
            <div className="pa-skeleton-row" key={row}>
              <Skeleton />
              <Skeleton />
              <Skeleton />
            </div>
          ))}
        </Card.Content>
      </Card>
    </div>
  );
}

export type StudentPageStateV1 = PortalLoadStateV1<SelfResponseV1> | { state: 'maintenance' };
export interface StudentPagePropsV1
  extends Omit<StudentShellPropsV1, 'children' | 'busy' | 'hero'> {
  load: StudentPageStateV1;
  status?: ReactNode;
  onRetry?: () => void;
  onLogin?: () => void;
  portraitSrc?: string;
  frequencyClient?: StudentFrequencyClientV2;
}

function errorMessageKindV1(state: string): StudentMessageKindV1 {
  if (state === 'unauthenticated') return 'expired';
  if (state === 'access-closed') return 'closed';
  if (state === 'unavailable' || state === 'forbidden') return 'unavailable';
  return 'error';
}

/** Consumes the foundation's load state. Error/loading transitions cannot retain old profile/grades. */
export function StudentPortalPageV1({
  load,
  status,
  onRetry,
  onLogin,
  portraitSrc,
  frequencyClient,
  ...shell
}: StudentPagePropsV1) {
  const gradesHeading = useId();
  let content: ReactNode = <StudentPageSkeletonV1 />;
  if (load.state === 'maintenance')
    content = <StudentPortalMessageV1 kind="maintenance" onAction={onRetry} />;
  else if (load.state === 'error') {
    const kind = errorMessageKindV1(load.error.state);
    content = (
      <StudentPortalMessageV1 kind={kind} onAction={kind === 'expired' ? onLogin : onRetry} />
    );
  } else if (load.state === 'ready')
    content = (
      <>
        {status}
        {load.data.state === 'no-publication' || load.data.subjects.length === 0 ? (
          <>
            <section className="pa-grades-section" aria-labelledby={gradesHeading}>
              <h2 id={gradesHeading} className="pa-section-title">
                Minhas notas
              </h2>
              <StudentPortalMessageV1 kind="empty" />
            </section>
          </>
        ) : (
          <StudentPortalWorkspaceV1
            data={load.data}
            profile={null}
          />
        )}
        <StudentFrequencyV2 key={load.data.profile.accountId} client={frequencyClient} onLogin={onLogin} />
      </>
    );
  const hero =
    load.state === 'ready' ? (
      <StudentProfileV1
        profile={load.data.profile}
        seals={brilliantSealCountV1(load.data.subjects, load.data.endedPeriods)}
        schoolName={shell.schoolName}
        logo={shell.logo}
        onLogout={shell.onLogout}
        loggingOut={shell.loggingOut}
        portraitSrc={portraitSrc}
      />
    ) : undefined;

  return (
    <StudentPortalShellV1
      {...shell}
      hero={hero}
      busy={load.state === 'idle' || load.state === 'loading'}
    >
      {content}
    </StudentPortalShellV1>
  );
}

import { useId, useRef, type ReactNode } from 'react';
import { Check, CircleAlert, LockKeyhole } from 'lucide-react';
import { SCHOOL_NAME_V1, SchoolMarkV1 } from '../../../shared/brand/school-mark-v1';
import '../shell/student-shell-v1.css';
import './student-entry-layout-v1.css';

// The school year matches the calendar year in the Portal's region.
const academicYearV1 = () => new Date().getFullYear();

function CoverV1({ splash = false }: Readonly<{ splash?: boolean }>) {
  return (
    <>
      <SchoolMarkV1 size={splash ? 104 : 84} pulse={splash} shine={!splash} className="pa-entry-crest" />
      <p className="pa-entry-eyebrow">Portal do Aluno</p>
      <p className="pa-entry-school">{SCHOOL_NAME_V1}</p>
      {splash ? null : <span className="pa-entry-year">Ano letivo {academicYearV1()}</span>}
    </>
  );
}

/** The school's front door: blue cover with the crest, and a white sheet with the sign-in. */
export function StudentEntryLayoutV1({ children, busy = false }: Readonly<{ children: ReactNode; busy?: boolean }>) {
  const contentId = useId();
  const content = useRef<HTMLElement>(null);
  return (
    <div className="pa-entry">
      <a
        className="pa-skip-link"
        href={'#' + contentId}
        onClick={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
      >
        Ir para o conteúdo
      </a>
      <header className="pa-entry-cover">
        <h1 className="pa-visually-hidden">Portal do Aluno · {SCHOOL_NAME_V1}</h1>
        <CoverV1 />
      </header>
      <main
        id={contentId}
        ref={content}
        className="pa-entry-sheet"
        tabIndex={-1}
        aria-busy={busy || undefined}
      >
        {children}
        <footer className="pa-entry-foot">
          <p>
            <LockKeyhole size={16} aria-hidden="true" />
            <span>Acesso individual e protegido. Seu cartão e sua senha são só seus.</span>
          </p>
          <p>
            <CircleAlert size={16} aria-hidden="true" />
            <span>Perdeu o cartão ou esqueceu a senha? Procure a secretaria da escola.</span>
          </p>
        </footer>
      </main>
    </div>
  );
}

/**
 * Opening screen while the session is checked, like an app launch: the crest pulses on the blue
 * cover. Right after a sign-in it confirms it and sketches the marks list that is on its way.
 */
export function StudentSplashV1({ entered = false }: Readonly<{ entered?: boolean }>) {
  return (
    <main
      className={'pa-access-check pa-entry pa-entry--splash' + (entered ? ' pa-entry--entered' : '')}
      aria-busy="true"
      aria-label="Verificando acesso ao Portal"
    >
      <div className="pa-entry-cover">
        {entered ? (
          <>
            <span className="pa-entry-check" aria-hidden="true">
              <Check size={40} strokeWidth={3} />
            </span>
            <p className="pa-entry-school">Tudo certo!</p>
            <p className="pa-entry-sub"><output className="contents">
              Abrindo o seu boletim…
            </output></p>
            <div className="pa-entry-skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
          </>
        ) : (
          <>
            <CoverV1 splash />
            <p className="pa-entry-sub"><output className="contents">
              Verificando acesso…
            </output></p>
          </>
        )}
      </div>
    </main>
  );
}

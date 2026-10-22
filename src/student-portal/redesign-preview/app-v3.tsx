import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { CalendarCheck2, NotebookPen } from 'lucide-react';
import {
  StudentPortalShellV1,
  StudentProfileV1,
} from '../../features/student-portal/shell/student-shell-v1';
import { StudentPortalWorkspaceV1 } from '../../features/student-portal/workspace/student-workspace-v1';
import { brilliantSealCountV1 } from '../../features/student-portal/grades/brilliant-seal-v1';
import { FrequencyPageV3 } from './frequency-page-v3';
import { demoFrequencyV3, REDESIGN_SELF_V3 } from './demo-data-v3';
// The portal's own shell styles (helpers such as the screen-reader-only text), loaded unchanged.
import '../../features/student-portal/shell/student-shell-v1.css';
import './redesign-v3.css';

/*
 * Redesign preview (owner request 20/10/2026, "caminho A"): the portal's own cover and white sheet,
 * shared by Notas and Frequência, and a menu of icons at the bottom on a phone and at the side on a
 * computer. Switching only changes what is inside the sheet: the cover, the sheet and the menu stay
 * still; the menu's highlight glides to the chosen item.
 */
type PageV3 = 'grades' | 'frequency';
const portrait = new URL('../assets/demo-student-boy.webp', import.meta.url).href;

const PAGES: readonly { id: PageV3; label: string; Icon: typeof NotebookPen }[] = [
  { id: 'grades', label: 'Notas', Icon: NotebookPen },
  { id: 'frequency', label: 'Frequência', Icon: CalendarCheck2 },
];

/*
 * Notas ⇄ Frequência (owner request 20/10/2026): the same move as between trimesters, inside the
 * sheet only. The content being left slides out to one side while the chosen one comes in from the
 * other; Frequência sits to the right of Notas, as in the menu.
 */
const SLIDE_MS_V3 = 340;
const SLIDE_EASING_V3 = 'cubic-bezier(0.4, 0, 0.2, 1)';
type SlideV3 = 'forward' | 'back';
const reducedMotionV3 = () =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** The menu's highlight: one pill that glides under the chosen icon. */
function useNavHighlightV3(page: PageV3) {
  const nav = useRef<HTMLElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const place = (animate: boolean) => {
      const icon = nav.current?.querySelector<HTMLElement>('[aria-current="page"] .pa3-nav-icon');
      const element = pill.current;
      if (!icon || !element || !nav.current) return;
      const box = nav.current.getBoundingClientRect();
      const rect = icon.getBoundingClientRect();
      element.style.transition = animate && !reducedMotionV3() ? '' : 'none';
      element.style.width = `${rect.width}px`;
      element.style.height = `${rect.height}px`;
      element.style.transform = `translate(${rect.left - box.left}px, ${rect.top - box.top}px)`;
      element.style.opacity = '1';
    };
    place(pill.current?.style.opacity === '1');
    const resize = () => place(false);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [page]);
  return { nav, pill };
}

/*
 * Notas ⇄ Frequência is a step of the browser's Back, kept beside the Notas workspace's own entry in
 * history.state (Copilot review of PR 1317): Back from Frequência returns to Notas as it was, and a
 * Back inside Notas never changes the page hidden behind Frequência.
 */
const PAGE_HISTORY_KEY_V3 = 'pa3Page';
const pageOfState = (state: unknown): PageV3 =>
  state && typeof state === 'object' && (state as Record<string, unknown>)[PAGE_HISTORY_KEY_V3] === 'frequency'
    ? 'frequency'
    : 'grades';

export function RedesignAppV3() {
  const data = REDESIGN_SELF_V3;
  const seals = brilliantSealCountV1(data.subjects, data.endedPeriods);
  const [page, setPage] = useState<PageV3>(() =>
    typeof window === 'undefined' ? 'grades' : pageOfState(window.history.state),
  );
  // The content sliding out, until its move ends.
  const [leaving, setLeaving] = useState<PageV3 | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const grades = useRef<HTMLDivElement>(null);
  const frequency = useRef<HTMLDivElement>(null);
  const entering = useRef<SlideV3 | null>(null);
  const highlight = useNavHighlightV3(page);
  const elementOf = (id: PageV3) => (id === 'grades' ? grades.current : frequency.current);
  // Set by a switch the reader asked for (menu or Back), never by the first render.
  const switched = useRef(false);
  // A Back or Forward that came during the slide: the browser has already moved in its history, so
  // it cannot be dropped like a second tap on the menu; it is applied when the slide ends.
  const pending = useRef<PageV3 | null>(null);
  const show = (next: PageV3) => {
    if (next === page) pending.current = null;
    if (next === page || leaving) return;
    pending.current = null;
    const direction: SlideV3 =
      PAGES.findIndex((item) => item.id === next) > PAGES.findIndex((item) => item.id === page)
        ? 'forward'
        : 'back';
    const animated = typeof elementOf(page)?.animate === 'function' && !reducedMotionV3();
    entering.current = animated ? direction : null;
    switched.current = true;
    if (animated) setLeaving(page);
    setPage(next);
  };
  const choose = (next: PageV3) => {
    if (next === page || leaving) return;
    const state = window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
    window.history.pushState({ ...state, [PAGE_HISTORY_KEY_V3]: next }, '');
    show(next);
  };
  const showRef = useRef(show);
  showRef.current = show;
  useEffect(() => {
    const restore = (event: PopStateEvent) => {
      pending.current = pageOfState(event.state);
      showRef.current(pending.current);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  // After a switch, with or without the slide: the top of the sheet in view (instantly) and the
  // focus on the page that came in, so a keyboard or screen reader starts there.
  useLayoutEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    const top = (stage.current?.getBoundingClientRect().top ?? 0) + window.scrollY - 16;
    if (window.scrollY > top) window.scrollTo({ top, behavior: 'instant' });
    elementOf(page)?.focus({ preventScroll: true });
  }, [page]);
  // Both moves start together, after the new content is in the sheet and before the browser paints.
  useLayoutEffect(() => {
    const direction = entering.current;
    entering.current = null;
    if (!direction || !leaving) return;
    const side = direction === 'forward' ? 1 : -1;
    elementOf(page)?.animate(
      [{ transform: `translateX(${side * 100}%)` }, { transform: 'translateX(0)' }],
      { duration: SLIDE_MS_V3, easing: SLIDE_EASING_V3 },
    );
    const outgoing = elementOf(leaving);
    if (!outgoing) {
      setLeaving(null);
      return;
    }
    const move = outgoing.animate(
      [{ transform: 'translateX(0)' }, { transform: `translateX(${-side * 100}%)` }],
      { duration: SLIDE_MS_V3, easing: SLIDE_EASING_V3, fill: 'forwards' },
    );
    // The content that left becomes invisible first, then its move is removed: a held move would
    // pull it out of the sheet again the next time it comes back.
    const done = () => {
      flushSync(() => setLeaving(null));
      move.cancel();
      if (pending.current) showRef.current(pending.current);
    };
    move.finished.then(done, done);
  }, [page]);
  // The contents never depend on which one is on screen: built once, so switching re-renders only
  // the two wrappers and the move starts at the next frame. Notas is the portal's real workspace
  // (its floating Boletim/Disciplina switch hidden: the menu replaces it); it stays mounted, so
  // coming back keeps the trimester and the discipline.
  const gradesContent = useMemo(
    () => <StudentPortalWorkspaceV1 data={{ ...data, showFrequency: false }} profile={null} />,
    [data],
  );
  // MERGE (portal real): this menu and its two pages go into the authenticated app (the shell of
  // StudentPortalPageV1), with the profile and `showFrequency` from /api/student/me. When
  // showFrequency !== true (the admin's "Frequência" policy key, off in production on 21/10/2026)
  // there is no menu and no Frequência page, and nothing of /api/student/frequency is fetched. The
  // page then reads the real client instead of demoFrequencyV3 (see frequency-page-v3.tsx).
  const frequencyContent = useMemo(() => <FrequencyPageV3 read={demoFrequencyV3} />, []);
  const hero = useMemo(
    () => (
      // No onLogout: the preview has no session, so it shows no "Sair" that would do nothing.
      <StudentProfileV1 profile={data.profile} seals={seals} portraitSrc={portrait} />
    ),
    [data, seals],
  );
  const stateOf = (id: PageV3) =>
    id === page ? '' : leaving === id ? ' pa3-panel--leaving' : ' pa3-panel--inactive';
  return (
    <div className="pa3-app pa3-app--cover">
      <nav ref={highlight.nav} className="pa3-nav" aria-label="Menu do Portal">
        <span ref={highlight.pill} className="pa3-nav-highlight" aria-hidden="true" />
        {PAGES.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className="pa3-nav-item"
            aria-current={page === id ? 'page' : undefined}
            aria-controls={`pa3-panel-${id}`}
            onClick={() => choose(id)}
          >
            <span className="pa3-nav-icon">
              <Icon size={22} aria-hidden="true" />
            </span>
            <span className="pa3-nav-label">{label}</span>
          </button>
        ))}
      </nav>

      <div className="pa3-page">
        <StudentPortalShellV1 hero={hero}>
          <div ref={stage} className="pa3-stage">
            <div
              ref={grades}
              id="pa3-panel-grades"
              role="region"
              aria-label="Notas"
              tabIndex={-1}
              inert={page !== 'grades'}
              className={'pa3-panel pa3-panel--grades' + stateOf('grades')}
            >
              {gradesContent}
            </div>
            <div
              ref={frequency}
              id="pa3-panel-frequency"
              role="region"
              aria-label="Frequência"
              tabIndex={-1}
              inert={page !== 'frequency'}
              className={'pa3-panel pa3-panel--frequency' + stateOf('frequency')}
            >
              {frequencyContent}
            </div>
          </div>
        </StudentPortalShellV1>
      </div>
    </div>
  );
}

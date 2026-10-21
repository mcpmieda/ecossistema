import { useLayoutEffect, useMemo, useRef, useState } from 'react';
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

export function RedesignAppV3() {
  const data = REDESIGN_SELF_V3;
  const seals = brilliantSealCountV1(data.subjects, data.endedPeriods);
  const [page, setPage] = useState<PageV3>('grades');
  // The content sliding out, until its move ends.
  const [leaving, setLeaving] = useState<PageV3 | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const grades = useRef<HTMLDivElement>(null);
  const frequency = useRef<HTMLDivElement>(null);
  const entering = useRef<SlideV3 | null>(null);
  const highlight = useNavHighlightV3(page);
  const elementOf = (id: PageV3) => (id === 'grades' ? grades.current : frequency.current);
  const choose = (next: PageV3) => {
    if (next === page || leaving) return;
    const direction: SlideV3 =
      PAGES.findIndex((item) => item.id === next) > PAGES.findIndex((item) => item.id === page)
        ? 'forward'
        : 'back';
    const animated = typeof elementOf(page)?.animate === 'function' && !reducedMotionV3();
    entering.current = animated ? direction : null;
    if (animated) setLeaving(page);
    setPage(next);
  };
  // Both moves start together, after the new content is in the sheet and before the browser paints.
  useLayoutEffect(() => {
    const direction = entering.current;
    entering.current = null;
    if (!direction || !leaving) return;
    // Read deep down the previous content? Bring the top of the sheet into view, instantly.
    const top = (stage.current?.getBoundingClientRect().top ?? 0) + window.scrollY - 16;
    if (window.scrollY > top) window.scrollTo({ top, behavior: 'instant' });
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
  const frequencyContent = useMemo(() => <FrequencyPageV3 read={demoFrequencyV3} />, []);
  const hero = useMemo(
    () => (
      <StudentProfileV1
        profile={data.profile}
        seals={seals}
        onLogout={() => undefined}
        portraitSrc={portrait}
      />
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
        <StudentPortalShellV1 onLogout={() => undefined} hero={hero}>
          <div ref={stage} className="pa3-stage">
            <div
              ref={grades}
              inert={page !== 'grades'}
              className={'pa3-panel pa3-panel--grades' + stateOf('grades')}
            >
              {gradesContent}
            </div>
            <div
              ref={frequency}
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

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { CalendarCheck2, Clock, NotebookPen } from 'lucide-react';
import { StudentPortalShellV1, type StudentShellPropsV1 } from '../shell/student-shell-v1';
// The portal's own shell styles (helpers such as the screen-reader-only text), loaded unchanged.
import '../shell/student-shell-v1.css';
import './redesign-v3.css';

/*
 * The Portal's pages (owner request 20/10/2026, "caminho A"; PR 1317): the portal's own cover and
 * white sheet, shared by Notas, Frequência and Horário (owner decision 22/10/2026), and a menu of
 * icons at the bottom on a phone and at the side on a computer. Switching only changes what is
 * inside the sheet: the cover, the sheet and the menu stay still; the menu's highlight glides to
 * the chosen item. A page the school turned off in the ADM (Frequência, Horário) has no menu item,
 * and with Notas alone there is no menu at all (the same new layout).
 */
export type PortalPageIdV3 = 'grades' | 'frequency' | 'schedule';
/**
 * Whether the page is the one on screen. A page behind the menu stays mounted (so coming back is
 * instant) but reads nothing until it is opened, and stops reading when another one is chosen.
 */
const PortalPageActiveV3 = createContext(true);
export const usePortalPageActiveV3 = () => useContext(PortalPageActiveV3);
type PageV3 = PortalPageIdV3;

const PAGES: readonly { id: PageV3; label: string; Icon: typeof NotebookPen }[] = [
  { id: 'grades', label: 'Notas', Icon: NotebookPen },
  { id: 'frequency', label: 'Frequência', Icon: CalendarCheck2 },
  { id: 'schedule', label: 'Horário', Icon: Clock },
];

/*
 * Notas ⇄ Frequência (owner request 20/10/2026): the same move as between trimesters, inside the
 * sheet only. The content being left slides out to one side while the chosen one comes in from the
 * other; each page sits to the right of the one before it, as in the menu (Notas, Frequência, Horário).
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
const pageOfState = (state: unknown, pages: readonly { id: PageV3 }[]): PageV3 => {
  const saved = state && typeof state === 'object' ? (state as Record<string, unknown>)[PAGE_HISTORY_KEY_V3] : null;
  return pages.find((item) => item.id === saved)?.id ?? 'grades';
};

export type PortalPagesPropsV3 = Omit<StudentShellPropsV1, 'children' | 'hero' | 'busy'> & {
  /** The student's cover (StudentProfileV1). */
  hero: ReactNode;
  /** Notas: the portal's workspace (and its notices), always there. */
  grades: ReactNode;
  /** Frequência, only when the school's "Frequência" key is on for the student. */
  frequency?: ReactNode;
  /** Horário, only when the school's "Horário" key is on for the student. */
  schedule?: ReactNode;
};

export function PortalPagesV3({ hero, grades, frequency, schedule, ...shell }: PortalPagesPropsV3) {
  const contentOf: Record<PageV3, ReactNode> = { grades, frequency, schedule };
  const pages = PAGES.filter((item) => item.id === 'grades' || contentOf[item.id] != null);
  // Notas alone (owner request 22/10/2026: "esse preview tá estranho, antigo"): the same new
  // layout, without a menu of one item.
  return <PortalMenuPagesV3 hero={hero} pages={pages} contentOf={contentOf} shell={shell} />;
}

function PortalMenuPagesV3({
  hero,
  pages,
  contentOf,
  shell,
}: {
  hero: ReactNode;
  pages: typeof PAGES;
  contentOf: Record<PageV3, ReactNode>;
  shell: Omit<StudentShellPropsV1, 'children' | 'hero' | 'busy'>;
}) {
  const [page, setPage] = useState<PageV3>(() =>
    typeof window === 'undefined' ? 'grades' : pageOfState(window.history.state, pages),
  );
  // The content sliding out, until its move ends.
  const [leaving, setLeaving] = useState<PageV3 | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const panels = useRef<Partial<Record<PageV3, HTMLDivElement | null>>>({});
  const entering = useRef<SlideV3 | null>(null);
  const highlight = useNavHighlightV3(page);
  const elementOf = (id: PageV3) => panels.current[id] ?? null;
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
      pages.findIndex((item) => item.id === next) > pages.findIndex((item) => item.id === page)
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
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  useEffect(() => {
    const restore = (event: PopStateEvent) => {
      pending.current = pageOfState(event.state, pagesRef.current);
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
  // The contents never depend on which one is on screen: built once by the caller, so switching
  // re-renders only the wrappers and the move starts at the next frame. Notas (the portal's
  // workspace, its floating Boletim/Disciplina switch hidden: the menu replaces it) stays mounted,
  // so coming back keeps the trimester and the discipline.
  const stateOf = (id: PageV3) =>
    id === page ? '' : leaving === id ? ' pa3-panel--leaving' : ' pa3-panel--inactive';
  return (
    <div className={'pa3-app pa3-app--cover' + (pages.length === 1 ? ' pa3-app--single' : '')}>
      <nav ref={highlight.nav} className="pa3-nav" aria-label="Menu do Portal" hidden={pages.length === 1}>
        <span ref={highlight.pill} className="pa3-nav-highlight" aria-hidden="true" />
        {pages.map(({ id, label, Icon }) => (
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
        <StudentPortalShellV1 {...shell} hero={hero}>
          <div ref={stage} className="pa3-stage">
            {pages.map(({ id, label }) => (
              <div
                key={id}
                ref={(element) => {
                  panels.current[id] = element;
                }}
                id={`pa3-panel-${id}`}
                role="region"
                aria-label={label}
                tabIndex={-1}
                inert={page !== id}
                className={`pa3-panel pa3-panel--${id}` + stateOf(id)}
              >
                <PortalPageActiveV3.Provider value={page === id}>{contentOf[id]}</PortalPageActiveV3.Provider>
              </div>
            ))}
          </div>
        </StudentPortalShellV1>
      </div>
    </div>
  );
}

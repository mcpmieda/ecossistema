import { useEffect } from 'react';

/** The drawer only exists up to this width (styles.css). */
const PHONE_V1 = '(max-width: 900px)';
const MIN_DISTANCE_V1 = 56;
const MAX_DURATION_V1 = 700;

/** An ancestor that is being, or can still be, slid sideways in the direction of the swipe:
 * a table, a row of tabs, a carousel. The swipe belongs to it, not to the drawer. */
function slidesSidewaysV1(target: EventTarget | null, toTheRight: boolean): boolean {
  for (
    let node = target instanceof Element ? target : null;
    node && node !== document.body;
    node = node.parentElement
  ) {
    if (node.scrollWidth <= node.clientWidth + 1) continue;
    const overflow = getComputedStyle(node).overflowX;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    // A finger moving right pulls the content back toward its start.
    if (toTheRight ? node.scrollLeft > 0 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1)
      return true;
  }
  return false;
}

/** Controls that use a sideways drag themselves, and other layers open over the page. */
const ownsTheDragV1 = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest('input, textarea, select, [contenteditable="true"], [role="slider"]') !== null;

/** What opens over the page: dialogs and confirmations, modal layers, popovers and menus.
 * A list or a menu that is simply part of the page is not one of them. */
const LAYERS_V1 =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [data-slot$="popover"]';
/** Whether any layer other than the drawer itself is really open. The drawer is told apart
 * element by element, so it never hides another layer that comes after it in the page. */
function otherLayerOpenV1(drawer: HTMLElement | null): boolean {
  return [...document.querySelectorAll<HTMLElement>(LAYERS_V1)].some(
    (layer) =>
      layer !== drawer &&
      !drawer?.contains(layer) &&
      !layer.contains(drawer) &&
      !layer.closest('[inert]') &&
      (typeof layer.checkVisibility !== 'function' || layer.checkVisibility()),
  );
}

/** The page enlarged by a pinch: a sideways drag then moves the enlarged view, not the drawer. */
const viewV1 = () => ({
  zoomed: (window.visualViewport?.scale ?? 1) > 1.01,
  left: window.visualViewport?.offsetLeft ?? 0,
});

/** A finger that has moved this far, clearly sideways, is dragging the drawer. */
const DRAG_LOCK_V1 = 14;
/** A drawer let go past this share of its width stays where it was heading. */
const SETTLE_SHARE_V1 = 0.4;
/** A quick flick (pixels per millisecond) also settles it, short as it is. */
const FLICK_SPEED_V1 = 0.45;

const NO_BACKDROP_V1 = { current: null };

type Gesture = {
  x: number;
  y: number;
  at: number;
  target: EventTarget | null;
  slidesRight: boolean;
  slidesLeft: boolean;
  zoomed: boolean;
  left: number;
  /** 'pending' until the finger shows where it goes; 'drag' while the drawer follows it. */
  mode: 'pending' | 'drag' | 'ignore';
  lastX: number;
  lastAt: number;
  speed: number;
};

/**
 * On phones, the side drawer follows a finger dragged sideways: to the right it slides in, to the
 * left it slides out, and on release it settles open or closed by how far and how fast it went
 * (owner request of 12/11/2026). Opening starts only on the left half of the screen. Vertical
 * scrolling, sideways-sliding content, text fields, any other open layer and a page enlarged by
 * zoom are left alone; the buttons keep working in every case.
 */
export function useDrawerSwipeV1(
  open: boolean,
  setOpen: (open: boolean) => void,
  drawer: { readonly current: HTMLElement | null },
  backdrop: { readonly current: HTMLElement | null } = NO_BACKDROP_V1,
) {
  useEffect(() => {
    // Whether the content under the finger could slide is read when the finger lands: by the
    // time it lifts, a table pulled back to its start would look like it could not.
    let gesture: Gesture | null = null;
    const phone = () => typeof window.matchMedia === 'function' && window.matchMedia(PHONE_V1).matches;
    const width = () => drawer.current?.getBoundingClientRect().width || 288;
    const release = () => {
      for (const element of [drawer.current, backdrop.current]) {
        element?.style.removeProperty('transform');
        element?.style.removeProperty('transition');
        element?.style.removeProperty('visibility');
        element?.style.removeProperty('opacity');
        if (element) delete element.dataset.dragging;
      }
    };
    /** How much of the drawer shows for this finger position, from 0 (shut) to 1 (open). */
    const shown = (from: Gesture, x: number) => {
      const dx = x - from.x;
      return Math.min(1, Math.max(0, open ? 1 + dx / width() : dx / width()));
    };
    const follow = (share: number) => {
      const element = drawer.current;
      if (element) {
        element.dataset.dragging = 'true';
        element.style.transition = 'none';
        element.style.visibility = 'visible';
        element.style.transform = `translateX(${(share - 1) * 100}%)`;
      }
      const shade = backdrop.current;
      if (shade) {
        shade.dataset.dragging = 'true';
        shade.style.transition = 'none';
        shade.style.opacity = String(share);
      }
    };
    const onStart = (event: TouchEvent) => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      if (gesture?.mode === 'drag') release();
      if (!touch) {
        gesture = null;
        return;
      }
      const now = Date.now();
      gesture = {
        x: touch.clientX,
        y: touch.clientY,
        at: now,
        target: event.target,
        slidesRight: slidesSidewaysV1(event.target, true),
        slidesLeft: slidesSidewaysV1(event.target, false),
        ...viewV1(),
        // Opening starts on the left half only: a sideways move elsewhere is left to the page.
        mode: !open && touch.clientX > window.innerWidth / 2 ? 'ignore' : 'pending',
        lastX: touch.clientX,
        lastAt: now,
        speed: 0,
      };
    };
    /** Whether this gesture may move the drawer at all, in the direction it took. */
    const allowed = (from: Gesture, dx: number) => {
      if (!phone() || ownsTheDragV1(from.target)) return false;
      // Zoomed when the finger landed or now, or the enlarged view moved in between.
      const view = viewV1();
      if (from.zoomed || view.zoomed || Math.abs(view.left - from.left) > 1) return false;
      // Another layer is open over the page (a confirmation, a student's drawer, a menu): the
      // drawer neither opens nor closes under it.
      if (otherLayerOpenV1(drawer.current)) return false;
      return open ? dx < 0 && !from.slidesLeft : dx > 0 && !from.slidesRight;
    };
    const onMove = (event: TouchEvent) => {
      const from = gesture;
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      if (!from || !touch || from.mode === 'ignore') return;
      const now = Date.now();
      // Speed over at least a frame, so one jittery sample is not read as a flick.
      if (now - from.lastAt >= 16) {
        from.speed = (touch.clientX - from.lastX) / (now - from.lastAt);
        from.lastX = touch.clientX;
        from.lastAt = now;
      }
      const dx = touch.clientX - from.x;
      const dy = touch.clientY - from.y;
      if (from.mode === 'pending') {
        // A vertical start is a scroll; only a clearly sideways move takes the drawer.
        if (Math.abs(dy) > DRAG_LOCK_V1 && Math.abs(dy) >= Math.abs(dx)) from.mode = 'ignore';
        else if (Math.abs(dx) >= DRAG_LOCK_V1 && Math.abs(dx) >= Math.abs(dy) * 2)
          from.mode = allowed(from, dx) ? 'drag' : 'ignore';
        if (from.mode !== 'drag') return;
      }
      if (event.cancelable) event.preventDefault();
      follow(shown(from, touch.clientX));
    };
    const onEnd = (event: TouchEvent) => {
      const from = gesture;
      gesture = null;
      const touch = event.changedTouches[0];
      if (!from || !touch || from.mode === 'ignore') return;
      const dx = touch.clientX - from.x;
      if (from.mode === 'drag') {
        const share = shown(from, touch.clientX);
        release();
        // A flick counts only after a real distance: a brush of the finger does not open it.
        const flick = Math.abs(from.speed) >= FLICK_SPEED_V1 && Math.abs(dx) >= MIN_DISTANCE_V1;
        const next = open
          ? !(share <= 1 - SETTLE_SHARE_V1 || (flick && from.speed < 0))
          : share >= SETTLE_SHARE_V1 || (flick && from.speed > 0);
        if (next !== open) setOpen(next);
        return;
      }
      // A swipe with no move in between (some browsers report none): long, quick and sideways.
      const dy = touch.clientY - from.y;
      if (Date.now() - from.at > MAX_DURATION_V1) return;
      if (Math.abs(dx) < MIN_DISTANCE_V1 || Math.abs(dx) < Math.abs(dy) * 2) return;
      if (allowed(from, dx)) setOpen(!open);
    };
    const onCancel = () => {
      if (gesture?.mode === 'drag') release();
      gesture = null;
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    // Not passive: while the drawer follows the finger the page must not scroll under it.
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onCancel);
      release();
    };
  }, [open, setOpen, drawer, backdrop]);
}

import { useEffect, useRef, type ReactNode } from 'react';

const SLIDE_V1: KeyframeAnimationOptions = { duration: 7000, direction: 'alternate' };

/**
 * One line of text. When it does not fit it ends in an ellipsis and slides to show the rest:
 * once when it appears, and again while the pointer is over its card or the card has keyboard focus.
 * It never loops on its own: a running animation makes every repaint of the page dearer, and
 * the grade matrices repaint on each move of the pointer.
 */
export function MarqueeTextV1({
  children,
  className = '',
}: Readonly<{
  children: ReactNode;
  className?: string;
}>) {
  const box = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const element = box.current;
    const text = element?.firstElementChild as HTMLElement | null | undefined;
    if (!element || !text) return;
    let hidden = 0;
    let slide: Animation | undefined;
    /** Pointer over the card; keyboard focus inside it (a click's focus does not count). */
    let over = false;
    let focused = false;
    const stop = () => {
      slide?.cancel();
      slide = undefined;
      delete element.dataset.moving;
    };
    const play = (iterations: number, delay: number) => {
      stop();
      if (
        hidden <= 1 ||
        typeof text.animate !== 'function' ||
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      )
        return;
      const end = `translateX(${-hidden}px)`;
      element.dataset.moving = '';
      const current = text.animate(
        [
          { transform: 'translateX(0)' },
          { transform: 'translateX(0)', offset: 0.18, easing: 'ease-in-out' },
          { transform: end, offset: 0.82 },
          { transform: end },
        ],
        { ...SLIDE_V1, delay, iterations },
      );
      current.onfinish = () => {
        if (slide === current) stop();
      };
      slide = current;
    };
    // Held on the card: a slide already under way keeps going without starting over.
    const sync = () => {
      const held = over || focused;
      const looping = slide?.effect?.getTiming().iterations === Infinity;
      if (!held) {
        if (looping) stop();
      } else if (slide) {
        slide.effect?.updateTiming({ iterations: Infinity });
      } else play(Infinity, 0);
    };
    const measure = () => {
      const next = Math.max(0, element.scrollWidth - element.clientWidth);
      if (Math.abs(next - hidden) < 1) return;
      hidden = next;
      if (over || focused) play(Infinity, 0);
      else play(2, 1000);
    };
    measure();
    const card = element.closest('button, a, .surface') ?? element;
    const enter = () => {
      over = true;
      sync();
    };
    const leave = () => {
      over = false;
      sync();
    };
    const focusIn = (event: Event) => {
      focused = event.target instanceof Element && event.target.matches(':focus-visible');
      sync();
    };
    const focusOut = () => {
      focused = false;
      sync();
    };
    card.addEventListener('pointerenter', enter);
    card.addEventListener('pointerleave', leave);
    card.addEventListener('focusin', focusIn);
    card.addEventListener('focusout', focusOut);
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      card.removeEventListener('pointerenter', enter);
      card.removeEventListener('pointerleave', leave);
      card.removeEventListener('focusin', focusIn);
      card.removeEventListener('focusout', focusOut);
      stop();
    };
  }, [children]);
  return (
    <span ref={box} className={`marquee-text-v1${className ? ' ' + className : ''}`}>
      <span>{children}</span>
    </span>
  );
}

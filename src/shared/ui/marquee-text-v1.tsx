import { useEffect, useRef, type ReactNode } from 'react';

/** One line of text. When it does not fit, it slides back and forth instead of being cut. */
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
    const measure = () => {
      const hidden = text.scrollWidth - element.clientWidth;
      element.toggleAttribute('data-sliding', hidden > 1);
      text.style.setProperty('--marquee-shift', `${-Math.max(0, hidden)}px`);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children]);
  return (
    <span ref={box} className={`marquee-text-v1${className ? ' ' + className : ''}`}>
      <span>{children}</span>
    </span>
  );
}

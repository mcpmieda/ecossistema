import type { ButtonHTMLAttributes, PointerEvent } from 'react';

/**
 * iOS and Android send no click after a long press. React Aria's Button clicks itself 80 ms
 * after the finger lifts over it when no click came; this keeps that for the native button.
 */
function clickAfterLongPressV1(event: PointerEvent<HTMLButtonElement>) {
  if (event.pointerType === 'mouse' || event.button !== 0) return;
  const button = event.currentTarget;
  const box = button.getBoundingClientRect();
  if (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  )
    return;
  let clicked = false;
  const mark = () => {
    clicked = true;
  };
  button.addEventListener('click', mark, { capture: true, once: true });
  setTimeout(() => {
    button.removeEventListener('click', mark, true);
    if (clicked || !button.isConnected) return;
    button.focus({ preventScroll: true });
    button.click();
  }, 80);
}

/**
 * Button inside the cells of dense tables (the grade matrices). A native button with HeroUI's
 * small ghost look: React Aria's Button runs press, hover and focus hooks per instance, and a
 * matrix holds hundreds of them, so each change of trimester or perspective mounted them all.
 */
export function CellButtonV1({
  className = '',
  ...props
}: Readonly<Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'onPointerUp'>>) {
  return (
    <button
      {...props}
      type="button"
      className={`button button--sm button--ghost cell-button-v1${className ? ' ' + className : ''}`}
      onPointerUp={clickAfterLongPressV1}
    />
  );
}

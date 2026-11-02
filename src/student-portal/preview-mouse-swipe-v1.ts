/*
 * Preview only (owner request 02/11/2026): on a computer there is no finger, so dragging with the
 * mouse sends the page the same touches a phone would. Never imported by the real portal.
 */
const IDENTIFIER = 1;
const MOVE_PX = 4;
let target: EventTarget | null = null;
let start = { x: 0, y: 0 };
let moved = false;

const send = (type: string, x: number, y: number) => {
  if (!target) return;
  const touch = new Touch({ identifier: IDENTIFIER, target, clientX: x, clientY: y });
  target.dispatchEvent(
    new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: type === 'touchend' ? [] : [touch],
      changedTouches: [touch],
    }),
  );
};

globalThis.addEventListener('mousedown', (event) => {
  // The simulator's own panel and its fields keep the mouse.
  if (event.button !== 0 || (event.target as Element).closest('details, input, select, textarea')) return;
  target = event.target;
  start = { x: event.clientX, y: event.clientY };
  moved = false;
  send('touchstart', event.clientX, event.clientY);
});
globalThis.addEventListener('mousemove', (event) => {
  if (!target) return;
  if (!moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) < MOVE_PX) return;
  // A drag, not a text selection.
  moved = true;
  document.body.style.userSelect = 'none';
  send('touchmove', event.clientX, event.clientY);
});
globalThis.addEventListener('mouseup', (event) => {
  if (!target) return;
  send('touchend', event.clientX, event.clientY);
  target = null;
  document.body.style.userSelect = '';
});

/*
 * The phone's back button closes what is open on top of the page (owner report of 12/11/2026:
 * "voltar" left the whole Centro). Every modal window, side panel and the phone menu is an
 * element with role="dialog" and aria-modal; while one is open, the history has one extra entry
 * with the same address. Back takes that entry away and the open layer is asked to close, as
 * Escape would; closing it any other way takes the entry away too, so the history stays as it was.
 */
import { useEffect } from 'react';

const MARK_V1 = '__centroOverlayV1';
/** Time for a window to close on Escape before it is taken as one that refuses to. */
const REFUSED_MS_V1 = 350;
const OPEN_SELECTOR_V1 = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';

function topLayer(): HTMLElement | null {
  // A window playing its closing animation is already closed.
  const open = [...document.querySelectorAll<HTMLElement>(OPEN_SELECTOR_V1)].filter(
    (layer) => !layer.closest('[data-exiting]'),
  );
  return open.at(-1) ?? null;
}

function marked(state: unknown): boolean {
  return typeof state === 'object' && state !== null && (state as Record<string, unknown>)[MARK_V1] === true;
}

function pressEscape(layer: HTMLElement): void {
  const active = document.activeElement;
  const target = active instanceof HTMLElement && layer.contains(active) ? active : layer;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
}

export function useBackClosesOverlayV1(): void {
  useEffect(() => {
    let pushed = false;
    let closingByBack = false;
    const push = () => {
      const current = window.history.state as Record<string, unknown> | null;
      window.history.pushState({ ...(current ?? {}), [MARK_V1]: true }, '');
      pushed = true;
    };
    const sync = () => {
      const layer = topLayer();
      if (layer && !pushed) push();
      else if (!layer && pushed) {
        pushed = false;
        // Closed on the page: take back the extra entry, unless the page already moved on.
        if (!closingByBack && marked(window.history.state)) window.history.back();
      }
      closingByBack = false;
    };
    const onPopState = () => {
      if (!pushed) return;
      pushed = false;
      const layer = topLayer();
      if (!layer) return;
      closingByBack = true;
      pressEscape(layer);
      // A layer that refuses Escape (a confirmation in progress) keeps its entry.
      window.setTimeout(() => {
        closingByBack = false;
        if (topLayer() === layer && !pushed) push();
      }, REFUSED_MS_V1);
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'role', 'data-exiting'],
    });
    window.addEventListener('popstate', onPopState);
    sync();
    return () => {
      observer.disconnect();
      window.removeEventListener('popstate', onPopState);
    };
  }, []);
}

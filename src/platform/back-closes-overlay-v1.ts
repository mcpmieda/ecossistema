/*
 * The phone's back button closes what is open on top of the page (owner report of 12/11/2026:
 * "voltar" left the whole Centro). While a layer is open (a modal window, a side panel, the phone
 * menu, an option list or popover), the history has one extra entry with the same address. Back
 * takes that entry away and the open layer is asked to close, as Escape would.
 * HeroUI's windows carry role="dialog" without aria-modal, so they are recognised by their own
 * slot (owner report of 12/11/2026: back left the student panel for the overview). A window with
 * steps inside marks its own "Voltar" with data-back-step: back presses it, one step at a time,
 * and only closes the window from its first step.
 * A layer closed on the page (Fechar, or an option picked) releases its entry: the next step or
 * layer reuses it, or, if nothing follows, it is taken away a moment later. Going back at once
 * could land after the choice just made and undo it. A link to another area from inside a layer
 * replaces the layer's entry, so one back returns to the area left.
 */
import { useEffect } from 'react';
import { allowDraftNavigationV1 } from '../shared/forms/draft-navigation-v1';
import { OVERLAY_ENTRY_V1 as MARK_V1, RELEASED_ENTRY_V1 } from '../shared/ui/history-step-v1';

/** Time for a window to close on Escape before it is taken as one that refuses to. */
const REFUSED_MS_V1 = 350;
/** Quiet time after a layer closes on the page before its released entry is taken away. */
const RELEASE_MS_V1 = 400;
const OPEN_SELECTOR_V1 = [
  '[role="dialog"][aria-modal="true"]',
  '[role="alertdialog"][aria-modal="true"]',
  '[data-slot="modal-dialog"]',
  '[data-slot="drawer-dialog"]',
  '[data-slot="alert-dialog-dialog"]',
  // Lists and popovers open over the page (a Select's options, a filter popover): back closes
  // them first instead of changing the choice underneath.
  '[data-slot="popover-dialog"]',
  '[data-slot$="-popover"]',
  // A panel of the page's own that closes on Escape (the phone search).
  '[data-back-layer]',
].join(', ');
/** The step back of a window with steps; the first one marked in the window is pressed. */
export const BACK_STEP_ATTRIBUTE_V1 = 'data-back-step';

function topLayer(): HTMLElement | null {
  // A window playing its closing animation is already closed.
  const open = [...document.querySelectorAll<HTMLElement>(OPEN_SELECTOR_V1)].filter(
    (layer) => !layer.closest('[data-exiting]'),
  );
  return open.at(-1) ?? null;
}

function stateRecord(): Record<string, unknown> | null {
  const state: unknown = window.history.state;
  return typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : null;
}

const marked = () => stateRecord()?.[MARK_V1] === true;
const released = () => stateRecord()?.[RELEASED_ENTRY_V1] === true;

function pressEscape(layer: HTMLElement): void {
  const active = document.activeElement;
  const target = active instanceof HTMLElement && layer.contains(active) ? active : layer;
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }),
  );
}

function backStep(layer: HTMLElement): HTMLElement | null {
  const step = layer.querySelector<HTMLElement>(`[${BACK_STEP_ATTRIBUTE_V1}]`);
  if (!step || step.closest(OPEN_SELECTOR_V1) !== layer) return null;
  const disabled = step.hasAttribute('disabled') || step.getAttribute('aria-disabled') === 'true';
  return disabled ? null : step;
}

/** Goes to another address of the Centro; from inside a layer, in place of the layer's entry. */
export function goToHashV1(hash: string): void {
  if (window.location.hash === hash) return;
  if (marked() || released()) window.location.replace(hash);
  else window.location.hash = hash;
}

export function useBackClosesOverlayV1(): void {
  useEffect(() => {
    let pushed = false;
    let closingByBack = false;
    let releaseTimer = 0;
    const push = () => {
      const { [RELEASED_ENTRY_V1]: _released, ...current } = stateRecord() ?? {};
      const entry = { ...current, [MARK_V1]: true };
      if (released()) window.history.replaceState(entry, '');
      else window.history.pushState(entry, '');
      pushed = true;
    };
    const release = () => {
      const { [MARK_V1]: _mark, ...current } = stateRecord() ?? {};
      window.history.replaceState({ ...current, [RELEASED_ENTRY_V1]: true }, '');
      window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(() => {
        if (released() && !pushed) window.history.back();
      }, RELEASE_MS_V1);
    };
    const sync = () => {
      const layer = topLayer();
      if (layer && !pushed) push();
      else if (!layer && pushed) {
        pushed = false;
        // Closed on the page: its entry is released, unless the page already moved on.
        if (!closingByBack && marked()) release();
      }
      closingByBack = false;
    };
    const onPopState = () => {
      if (!pushed) return;
      pushed = false;
      const layer = topLayer();
      if (!layer) return;
      const step = backStep(layer);
      if (step) {
        // One step back inside the window, which stays open with its entry; if that step was the
        // way out (back to a list behind it), the window closes and the entry is released.
        step.click();
        push();
        return;
      }
      closingByBack = true;
      pressEscape(layer);
      // A layer that refuses Escape (a confirmation in progress) keeps its entry.
      window.setTimeout(() => {
        closingByBack = false;
        if (topLayer() === layer && !pushed) push();
      }, REFUSED_MS_V1);
    };
    const onClick = (event: MouseEvent) => {
      if (!pushed || event.defaultPrevented || event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#"]') : null;
      const layer = topLayer();
      const hash = anchor?.getAttribute('href');
      if (!anchor || !layer?.contains(anchor) || !hash || anchor.target === '_blank') return;
      if (hash === window.location.hash || !allowDraftNavigationV1()) return;
      event.preventDefault();
      goToHashV1(hash);
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'role', 'data-exiting', 'data-back-layer'],
    });
    window.addEventListener('popstate', onPopState);
    document.addEventListener('click', onClick);
    sync();
    return () => {
      observer.disconnect();
      window.clearTimeout(releaseTimer);
      window.removeEventListener('popstate', onPopState);
      document.removeEventListener('click', onClick);
    };
  }, []);
}

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
import {
  addEntryV1,
  mayAddEntryV1,
  OVERLAY_ENTRY_V1 as MARK_V1,
  RELEASED_ENTRY_V1,
} from '../shared/ui/history-step-v1';

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
/**
 * The step back of a window with steps; the first one marked in the window is pressed. Its value
 * is how many steps are open inside the window, so each step gets an entry of its own.
 */
export const BACK_STEP_ATTRIBUTE_V1 = 'data-back-step';

/** The open layers, bottom to top. A window playing its closing animation is already closed. */
function openLayers(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(OPEN_SELECTOR_V1)].filter(
    (layer) => !layer.closest('[data-exiting]'),
  );
}
const topLayer = () => openLayers().at(-1) ?? null;

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

/** How many steps deep the window is: the number its "Voltar" carries (0 for a way out). */
function stepDepth(layer: HTMLElement): number {
  const value = Number(backStep(layer)?.getAttribute(BACK_STEP_ATTRIBUTE_V1));
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/** Goes to another address of the Centro; from inside a layer, in place of the layer's entry. */
export function goToHashV1(hash: string): void {
  if (window.location.hash === hash) return;
  if (marked() || released()) window.location.replace(hash);
  else window.location.hash = hash;
}

export function useBackClosesOverlayV1(): void {
  useEffect(() => {
    /** The open layers that have entries, bottom to top, with the steps open inside each. */
    const stack: { layer: HTMLElement; depth: number }[] = [];
    /**
     * Layers open without a tap of their own: they get no entry (Chrome would skip it). Only for
     * that opening: a layer kept in the page (the phone menu) gets its entry when opened by a tap.
     */
    const unentered = new Set<HTMLElement>();
    /** Moves through the history made here, which the page must not take as the user's back. */
    let ownMoves = 0;
    /** A layer that refused to close, waiting for its entry to come back by going forward. */
    let restoring: { layer: HTMLElement; depth: number } | null = null;
    let releaseTimer = 0;
    const markedEntry = () => {
      const { [RELEASED_ENTRY_V1]: _released, ...current } = stateRecord() ?? {};
      return { ...current, [MARK_V1]: true };
    };
    const enter = (layer: HTMLElement) => {
      if (released()) window.history.replaceState(markedEntry(), '');
      else if (!mayAddEntryV1() || !addEntryV1(markedEntry())) {
        unentered.add(layer);
        return;
      }
      stack.push({ layer, depth: 0 });
    };
    const release = () => {
      const { [MARK_V1]: _mark, ...current } = stateRecord() ?? {};
      window.history.replaceState({ ...current, [RELEASED_ENTRY_V1]: true }, '');
      window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(() => {
        if (released() && stack.length === 0) {
          ownMoves += 1;
          window.history.back();
        }
      }, RELEASE_MS_V1);
    };
    const goBackOwn = (entries: number) => {
      ownMoves += 1;
      window.history.go(-entries);
    };
    const sync = () => {
      const open = openLayers();
      for (const layer of [...unentered]) if (!open.includes(layer)) unentered.delete(layer);
      // Layers closed on the page (Fechar, an option picked) take their entries away.
      let closed = 0;
      for (let index = stack.length - 1; index >= 0; index -= 1)
        if (!open.includes(stack[index]!.layer)) closed += 1 + stack.splice(index, 1)[0]!.depth;
      // A single plain layer releases its entry: going back at once could undo a choice just made.
      if (closed === 1 && marked()) release();
      else if (closed > 1 && marked()) goBackOwn(closed);
      for (const layer of open)
        if (!unentered.has(layer) && !stack.some((item) => item.layer === layer)) enter(layer);
      const top = stack.at(-1);
      if (!top || top.layer !== open.at(-1)) return;
      const wanted = stepDepth(top.layer);
      // A step opened by a tap gets its entry at once, while the tap still counts as the user's.
      if (wanted > top.depth && mayAddEntryV1() && addEntryV1(markedEntry())) top.depth += 1;
      else if (wanted < top.depth) {
        // Stepped back with the window's own "Voltar": the entries of those steps go too.
        goBackOwn(top.depth - wanted);
        top.depth = wanted;
      }
    };
    const onPopState = () => {
      if (restoring) {
        stack.push(restoring);
        restoring = null;
        return;
      }
      if (ownMoves > 0) {
        ownMoves -= 1;
        return;
      }
      const top = stack.at(-1);
      if (!top) return;
      if (!openLayers().includes(top.layer)) {
        stack.pop();
        return;
      }
      if (top.depth > 0) {
        // The entry of the last step inside the window: one step back, the window stays.
        top.depth -= 1;
        backStep(top.layer)?.click();
        return;
      }
      stack.pop();
      const step = backStep(top.layer);
      if (step) {
        // The way out of a window opened from a list ("Voltar à lista") reopens that list.
        step.click();
        return;
      }
      pressEscape(top.layer);
      // A layer that refuses Escape (a confirmation in progress) gets its entry back by going
      // forward to it; adding a new one without a tap would make Chrome skip entries.
      window.setTimeout(() => {
        if (openLayers().includes(top.layer)) {
          restoring = top;
          window.history.forward();
        }
      }, REFUSED_MS_V1);
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#"]') : null;
      const hash = anchor?.getAttribute('href');
      if (!anchor || !hash || anchor.target === '_blank') return;
      // From inside a layer, or on the entry a layer just released (the search closed by this
      // very tap): the link takes that entry's place, so no back is pressed in vain.
      const fromLayer = stack.length > 0 && topLayer()?.contains(anchor) === true;
      if (!fromLayer && !released()) return;
      if (hash === window.location.hash || !allowDraftNavigationV1()) return;
      event.preventDefault();
      goToHashV1(hash);
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'role', 'data-exiting', 'data-back-layer', BACK_STEP_ATTRIBUTE_V1],
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

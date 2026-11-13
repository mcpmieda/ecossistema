import { createElement, useEffect, useSyncExternalStore } from 'react';
import { subscribeLiveChangesV1 } from '../live-data/live-refresh-v1';
const EVENT = 'ecossistema-before-navigation';
const pending = new Set<object>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const getSnapshot = () => pending.size > 0;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** A broad notice cannot identify a changed student. Drafts and original CAS remain owned
 * by the form controller; this registry contains only anonymous in-memory guard tokens.
 */
export function DraftUpdatesNoticeV1() {
  const changed = useSyncExternalStore(subscribe, getSnapshot, () => false);
  return changed ? createElement('p', {
    role: 'status', className: 'mb-3 rounded-xl border border-border/60 px-3 py-2 text-sm text-muted',
  }, 'Há atualizações a conferir. Sua edição foi preservada; revise os dados antes de salvar.') : null;
}

/** A pending edit must not be destroyed by the surrounding tabs or links. */
export function allowDraftNavigationV1(): boolean {
  return window.dispatchEvent(new Event(EVENT, { cancelable: true }));
}

/** The question asked when the phone's back would leave a screen with an edit not saved. */
export const DISCARD_DRAFT_PROMPT_V1 = 'Descartar edição? As alterações não salvas serão perdidas.';
/** Time for the refused address to come back by going forward before it is put back in place. */
const RESTORE_MS_V1 = 350;
/** The address on screen; a back or forward that changes it asks the open edits first. */
let shownHash = typeof window === 'undefined' ? '' : window.location.hash;
/** The address refused, whose own hashchange is still to come. */
let refusedHash: string | null = null;
/** The address being returned to after a refusal. */
let restoringHash: string | null = null;
let restoreTimer = 0;
const hashOf = (url: string) => {
  try { return new URL(url).hash; } catch { return window.location.hash; }
};
const allowLeaving = () => allowDraftNavigationV1() || window.confirm(DISCARD_DRAFT_PROMPT_V1);
/**
 * A move the Centro makes by itself to another address (a search result) asks the open edits once,
 * before the address changes: refusing leaves the address and the history as they are.
 */
export function allowLeavingToV1(href: string): boolean {
  if (!allowLeaving()) return false;
  try { shownHash = new URL(href, window.location.href).hash; } catch { /* asked again on arrival */ }
  return true;
}
/*
 * The phone's back (or forward) to another address of the Centro passes through the edits too:
 * if one refuses, no screen hears of it and the address goes forward again to the one shown. An
 * entry added here, with no tap, would make Chrome skip entries, so it never pushes one.
 */
function onTraverse(event: Event): void {
  const hash = window.location.hash;
  if (restoringHash !== null && hash === restoringHash) {
    event.stopImmediatePropagation();
    return;
  }
  if (hash === shownHash) return;
  if (allowLeaving()) {
    shownHash = hash;
    return;
  }
  event.stopImmediatePropagation();
  refusedHash = hash;
  restoringHash = shownHash;
  window.history.forward();
  window.clearTimeout(restoreTimer);
  restoreTimer = window.setTimeout(() => {
    // No entry ahead (an address changed in place): the shown address takes its place.
    if (restoringHash !== null && window.location.hash !== restoringHash)
      window.location.replace(restoringHash);
  }, RESTORE_MS_V1);
}
function onHashChange(event: HashChangeEvent): void {
  const hash = hashOf(event.newURL);
  if (refusedHash !== null && hash === refusedHash) {
    refusedHash = null;
    event.stopImmediatePropagation();
    return;
  }
  if (restoringHash !== null && hash === restoringHash) {
    restoringHash = null;
    refusedHash = null;
    window.clearTimeout(restoreTimer);
    event.stopImmediatePropagation();
    return;
  }
  // An address change that came without its popstate is asked here.
  if (hash !== shownHash && !allowLeaving()) {
    event.stopImmediatePropagation();
    restoringHash = shownHash;
    window.location.replace(shownHash);
    return;
  }
  shownHash = hash;
}
if (typeof window !== 'undefined') {
  // Capture, and installed on import: before the screens that change with the address.
  window.addEventListener('popstate', onTraverse, true);
  window.addEventListener('hashchange', onHashChange, true);
}

export function useDraftNavigationGuardV1(blocked: boolean): void {
  useEffect(() => {
    if (!blocked) return;
    shownHash = window.location.hash;
    const token = {};
    const unsubscribe = subscribeLiveChangesV1(() => {
      if (!pending.has(token)) { pending.add(token); emit(); }
    });
    const prevent = (event: Event) => event.preventDefault();
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = ''; // NOSONAR older browsers still need it to show the prompt
    };
    const link = (event: MouseEvent) => {
      const anchor =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (
        anchor &&
        anchor.href !== window.location.href &&
        !event.ctrlKey &&
        !event.metaKey &&
        anchor.target !== '_blank'
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener(EVENT, prevent);
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', link, true);
    return () => {
      unsubscribe();
      if (pending.delete(token)) emit();
      window.removeEventListener(EVENT, prevent);
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', link, true);
    };
  }, [blocked]);
}

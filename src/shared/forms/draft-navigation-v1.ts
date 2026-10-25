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
export function useDraftNavigationGuardV1(blocked: boolean): void {
  useEffect(() => {
    if (!blocked) return;
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

import { vi } from 'vitest';

/** Explicit synthetic intersection: UI tests must not depend on the no-observer fallback
 * draining an entire collection. Other observed HeroUI elements are left untouched. */
export function controlledContinuousObserverV1() {
  const observers = new Set<Observer>();
  class Observer {
    readonly targets = new Set<Element>();
    readonly callback: IntersectionObserverCallback;
    readonly root: Element | Document | null;
    readonly rootMargin: string;
    readonly thresholds = [0];
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.callback = callback;
      this.root = options?.root ?? null;
      this.rootMargin = options?.rootMargin ?? '0px';
      observers.add(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
      observers.delete(this);
    }
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', Observer);
  const ends = () =>
    [...observers].flatMap((observer) =>
      [...observer.targets]
        .filter((target) => target.matches('.pa-continuous-end'))
        .map((target) => ({ observer, target })),
    );
  return {
    isObserving: () => ends().length > 0,
    intersect(isIntersecting = true) {
      const active = ends();
      if (!active.length) throw new Error('No continuous-list sentinel is being observed');
      for (const { observer, target } of active) {
        const rect = target.getBoundingClientRect();
        observer.callback(
          [
            {
              target,
              isIntersecting,
              intersectionRatio: isIntersecting ? 1 : 0,
              boundingClientRect: rect,
              intersectionRect: rect,
              rootBounds: null,
              time: 0,
            },
          ],
          observer as unknown as IntersectionObserver,
        );
      }
    },
  };
}

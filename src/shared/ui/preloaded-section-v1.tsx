import { lazy, useEffect, useState, type ComponentType, type ElementType } from 'react';

interface PreloadableSectionV1 {
  preload(): void;
}

/** A section whose bundle already arrived mounts directly, with no loading state in between.
 * Until then it loads on demand, exactly like a lazy component under its Suspense boundary. */
export function preloadedSectionV1<P extends object>(load: () => Promise<ComponentType<P>>) {
  let ready: ComponentType<P> | undefined;
  const run = () =>
    load().then((component) => {
      ready = component;
      return { default: component };
    });
  const Deferred = lazy(run);
  function Section(props: P) {
    // Chosen once per mount: a bundle arriving later must not remount an area in use.
    const [Component] = useState<ElementType>(() => ready ?? Deferred);
    return <Component {...props} />;
  }
  Section.preload = () => {
    // A failed preload is not an error of the area: opening it asks again and reports there.
    void run().catch(() => undefined);
  };
  return Section;
}

/** Brings the other areas while the browser is idle, so opening them waits for no download. */
export function usePreloadedSectionsV1(sections: readonly PreloadableSectionV1[]) {
  useEffect(() => {
    const preloadAll = () => {
      for (const section of sections) section.preload();
    };
    // Safari on the iPhone has no idle callback: the areas come a moment after the page instead.
    if (typeof window.requestIdleCallback !== 'function') {
      const timer = window.setTimeout(preloadAll, 2000);
      return () => window.clearTimeout(timer);
    }
    const idle = window.requestIdleCallback(preloadAll, { timeout: 4000 });
    return () => window.cancelIdleCallback(idle);
  }, [sections]);
}

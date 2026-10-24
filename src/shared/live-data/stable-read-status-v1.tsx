import { Spinner } from '@heroui/react';

/** Visibility preserves the exact wrapped text/spinner footprint during background reads.
 * Keep this mounted beside the data; never conditionally insert the status row itself. */
export function StableReadStatusV1({ busy, children }: Readonly<{ busy: boolean; children: string }>) {
  return (
    <p
      aria-hidden={!busy}
      className="flex min-w-0 items-center gap-2 text-xs text-muted"
      style={{ visibility: busy ? 'visible' : 'hidden' }}
    ><output className="contents" aria-live="polite">
      <span className="shrink-0" aria-hidden="true"><Spinner size="sm" /></span>
      <span>{children}</span>
    </output></p>
  );
}

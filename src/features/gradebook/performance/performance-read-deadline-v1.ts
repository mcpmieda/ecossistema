/** A client deadline for read-only performance requests, including their response body.
 * It releases the UI and aborts fetch; it is not a server-side SQL cancellation guarantee.
 * Never wrap imports, saves or publication commands with this helper.
 */
export const PERFORMANCE_READ_TIMEOUT_V1 = 30_000;

export async function withPerformanceReadDeadlineV1<T>(
  read: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<T> {
  if (parent?.aborted) throw parent.reason ?? new DOMException('Leitura cancelada.', 'AbortError');
  const controller = new AbortController();
  let rejectAbort: (reason: unknown) => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(controller.signal.reason);
  const onParentAbort = () =>
    controller.abort(parent?.reason ?? new DOMException('Leitura cancelada.', 'AbortError'));
  controller.signal.addEventListener('abort', onAbort, { once: true });
  parent?.addEventListener('abort', onParentAbort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('A consulta excedeu o prazo de espera.', 'TimeoutError'));
  }, PERFORMANCE_READ_TIMEOUT_V1);
  try {
    const operation = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return read(controller.signal);
    });
    return await Promise.race([operation, cancelled]);
  } finally {
    clearTimeout(timeout);
    parent?.removeEventListener('abort', onParentAbort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

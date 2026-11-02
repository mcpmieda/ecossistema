/**
 * Ends a read when its caller gives up or after `timeoutMs`. Written by hand because
 * AbortSignal.any only exists from Safari 17.4 and Chrome 116: on an older phone it would throw before
 * the request even left, and the page could never load.
 */
export function requestSignalV1(parent?: AbortSignal | null, timeoutMs = 15_000): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The read took too long', 'TimeoutError')), timeoutMs);
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener('abort', () => controller.abort(parent.reason), { once: true, signal: controller.signal });
  return controller.signal;
}

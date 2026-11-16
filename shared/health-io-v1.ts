import { SYSTEM_HEALTH_BODY_BYTES_V1 } from './system-health-v1';

/** Races the complete operation, including body reads and transports ignoring AbortSignal. */
export async function healthDeadlineV1<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let rejectAbort: (() => void) | undefined;
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    signal.throwIfAborted();
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return run(signal);
      }),
      new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(new Error('health-read-aborted'));
        signal.addEventListener('abort', rejectAbort, { once: true });
        if (signal.aborted) rejectAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (rejectAbort) signal.removeEventListener('abort', rejectAbort);
  }
}

export async function readHealthJsonV1(
  response: Response,
  signal: AbortSignal,
  maxBytes = SYSTEM_HEALTH_BODY_BYTES_V1,
): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d{1,9}$/u.test(length) || Number(length) > maxBytes)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('health-response-too-large');
  }
  if (!response.body) throw new Error('health-response-missing');
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  let completed = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error('health-response-too-large');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const result: unknown = JSON.parse(text);
    completed = true;
    return result;
  } finally {
    if (!completed) cancel();
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

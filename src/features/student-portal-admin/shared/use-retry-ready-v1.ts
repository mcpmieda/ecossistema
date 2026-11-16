import { useEffect, useState } from 'react';

/** Whether the wait before trying again is over (`retryAt` in epoch ms; 0 means no wait). One
 * timer until `retryAt` and one render when it ends: nothing ticks while an error stays on screen. */
export function useRetryReadyV1(retryAt: number): boolean {
  // A moment already reached: every `retryAt` up to it is over.
  const [reached, setReached] = useState(Date.now);
  useEffect(() => {
    const reach = () => setReached((value) => Math.max(value, retryAt));
    const wait = retryAt - Date.now();
    if (wait <= 0) {
      reach();
      return;
    }
    const timer = setTimeout(reach, wait);
    return () => clearTimeout(timer);
  }, [retryAt]);
  return retryAt <= reached;
}

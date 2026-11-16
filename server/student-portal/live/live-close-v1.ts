import {
  emitPortalLiveCloseMetricV1,
  type PortalLiveCloseMetricV1,
} from '../observability/metrics-v1';

type LiveSocketV1 = { readonly readyState: number; close(code?: number, reason?: string): void };
type SinkV1 = (value: PortalLiveCloseMetricV1) => void;

/** Close codes a WebSocket endpoint may send in a Close frame (RFC 6455 §7.4). */
export function sendableCloseCodeV1(code: number): boolean {
  return (
    Number.isInteger(code) &&
    ((code >= 1000 && code <= 1003) ||
      (code >= 1007 && code <= 1014) ||
      (code >= 3000 && code <= 4999))
  );
}

/** A code class, not a cause: no-status is only a close without code, abnormal only an abnormal end. */
export function liveCloseCodeClassV1(code: number): PortalLiveCloseMetricV1['codeClass'] {
  if (code === 1000) return 'normal';
  if (code === 1001) return 'going-away';
  if (code === 4401) return 'auth-expired';
  if (code === 1005) return 'no-status';
  if (code === 1006) return 'abnormal';
  if (code === 1015) return 'tls-reserved';
  return sendableCloseCodeV1(code) ? 'other-sendable' : 'other-invalid';
}

function liveReadyStateV1(socket: LiveSocketV1): PortalLiveCloseMetricV1['readyState'] {
  const state = socket.readyState;
  return Number.isInteger(state) && state >= 0 && state <= 3 ? state : 'unknown';
}

/**
 * Hibernation close callback. Reserved codes (1005 no status, 1006 abnormal,
 * 1015 TLS) cannot be sent back and throw; answering them with a normal close still completes
 * the handshake. The signal is emitted before close, so it does not prove the peer received it.
 */
export function answerLiveCloseV1(
  socket: LiveSocketV1,
  code: number,
  reason: string,
  sink?: SinkV1,
): void {
  emitPortalLiveCloseMetricV1(
    {
      event: 'student-portal-live-close-v1',
      callback: 'close',
      codeClass: liveCloseCodeClassV1(code),
      readyState: liveReadyStateV1(socket),
    },
    sink,
  );
  if (sendableCloseCodeV1(code)) socket.close(code, reason);
  else socket.close(1000);
}

export function failLiveSocketV1(socket: LiveSocketV1, sink?: SinkV1): void {
  emitPortalLiveCloseMetricV1(
    {
      event: 'student-portal-live-close-v1',
      callback: 'error',
      codeClass: 'not-applicable',
      readyState: liveReadyStateV1(socket),
    },
    sink,
  );
  socket.close(1011, 'socket-error');
}

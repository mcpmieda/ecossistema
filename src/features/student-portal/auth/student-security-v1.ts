import { PortalClientErrorV1 } from '../shared/transport-v1';
import { instantV1 } from '../../../../shared/student-portal-contracts/core-v1';

export interface StudentSecuritySocketV1 {
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  send(message: string): void;
  close(): void;
}

/** A rate-limited verification waits what the server asks (15 s to one day) and blocks earlier
 * checks; any other failure retries in 15 s. */
function verificationRetryV1(error: unknown) {
  if (error instanceof PortalClientErrorV1 && error.state === 'rate-limited')
    return { wait: Math.max(15_000, Math.min(86_400, error.retryAfterSeconds ?? 60) * 1000), limited: true };
  return { wait: 15_000, limited: false };
}

/** A security channel message: small JSON of contract version 1; pongs and anything else are ignored. */
function securityMessageV1(data: unknown): Record<string, unknown> | null {
  if (data === 'security-pong') return null;
  if (typeof data !== 'string' || data.length > 128) return null;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (!message || typeof message !== 'object') return null;
  const value = message as Record<string, unknown>;
  return value.contractVersion === 1 ? value : null;
}

/** The connected handshake: exact keys, and an expiry wherever renewal or a lease is offered. */
function securityHandshakeV1(value: Record<string, unknown>) {
  const keys = Object.keys(value).length;
  const supportsRenewal = value.renewable === true;
  const expiry = instantV1.safeParse(value.expiresAt);
  if (supportsRenewal ? keys !== 4 || !expiry.success : keys !== 2 && (keys !== 3 || !expiry.success)) return null;
  return { keys, supportsRenewal, expiry };
}

/** The lease a fresh handshake grants (its expiry), or null: older servers only confirm the session. */
function handshakeLeaseV1(
  { keys, supportsRenewal, expiry }: NonNullable<ReturnType<typeof securityHandshakeV1>>,
  startedAt: number,
) {
  return (keys === 3 || supportsRenewal) &&
    expiry.success &&
    Date.now() < startedAt + 60_000 &&
    Date.parse(expiry.data) > Date.now()
    ? expiry.data
    : null;
}

/** Security leases never request or invalidate the academic snapshot. */
export function createStudentSecurityV1(options: {
  connect: (connectionId?: string) => StudentSecuritySocketV1;
  /** Session-only check. Must publish and throw on revocation; throws on network uncertainty. */
  authorize: (signal: AbortSignal, connectionId?: string) => Promise<boolean | void>;
  /** Receives only the effective expiry confirmed by the authorized handshake. */
  onAuthorized?: (expiresAt: string, startedAt: number) => boolean;
}) {
  let disposed = false;
  let socket: StudentSecuritySocketV1 | undefined;
  let retry = 1000;
  let connectionId: string | undefined;
  let renewable = false;
  let attemptRenewal = true;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let rotation: ReturnType<typeof setTimeout> | undefined;
  let lease: ReturnType<typeof setTimeout> | undefined;
  let checking = false,
    again = false;
  let request: AbortController | undefined;
  let limitedUntil = 0;
  let requestTimeout: ReturnType<typeof setTimeout> | undefined;
  let noticeVersion = 0,
    lastHttpStartedAt = 0;
  const disconnect = () => {
    clearInterval(heartbeat);
    clearTimeout(rotation);
    renewable = false;
    connectionId = undefined;
    if (!socket) return;
    const previous = socket;
    socket = undefined;
    previous.onopen = null;
    previous.onmessage = null;
    previous.onclose = null;
    previous.onerror = null;
    previous.close();
  };
  const dispose = () => {
    disposed = true;
    request?.abort();
    clearTimeout(requestTimeout);
    clearTimeout(reconnect);
    clearTimeout(lease);
    disconnect();
  };
  const renew = (verifiedAt = Date.now()) => {
    clearTimeout(lease);
    lease = setTimeout(() => void authorize(), Math.max(0, (renewable ? 45_000 : 60_000) - (Date.now() - verifiedAt)));
  };
  // Stable login (owner decision, 22/09/2026): when the lease is due, re-check the session over
  // HTTP (never /me). Only a confirmed revocation hides content — `authorize` publishes it and
  // the session hook disposes this channel. Network uncertainty (socket blocked, tab resumed
  // after the OS suspended it, flaky mobile data) keeps the content and retries shortly.
  /** A renewal the server did not confirm reconnects that same socket; the lease restarts either way. */
  function afterVerification(
    renewalId: string | undefined,
    current: StudentSecuritySocketV1 | undefined,
    renewed: unknown,
    startedAt: number,
  ) {
    if (renewalId && current === socket && renewed !== true) {
      disconnect();
      connect();
    }
    renew(startedAt);
  }
  /** Network uncertainty does not revoke an account or extend its authorization lease. */
  function verificationFailed(error: unknown) {
    clearTimeout(lease);
    const { wait, limited } = verificationRetryV1(error);
    if (limited) limitedUntil = Date.now() + wait;
    lease = setTimeout(() => void authorize(), wait);
    if (!socket) schedule();
  }
  const authorize = async (repeat = false) => {
    if (disposed) return;
    if (Date.now() < limitedUntil) {
      clearTimeout(lease);
      lease = setTimeout(() => void authorize(), limitedUntil - Date.now());
      return;
    }
    if (checking) {
      again ||= repeat;
      return;
    }
    checking = true;
    const startedAt = Date.now();
    lastHttpStartedAt = startedAt;
    const controller = new AbortController();
    request = controller;
    try {
      const current = socket;
      const renewalId = renewable ? connectionId : undefined;
      const renewed = await Promise.race([
        options.authorize(controller.signal, renewalId),
        new Promise((_, reject) => {
          requestTimeout = setTimeout(() => {
            controller.abort();
            reject(new Error('security-verification-timeout'));
          }, 10_000);
        }),
      ]);
      controller.signal.throwIfAborted();
      if (!disposed && !again) afterVerification(renewalId, current, renewed, startedAt);
    } catch (error) {
      if (!disposed) verificationFailed(error);
    } finally {
      clearTimeout(requestTimeout);
      request = undefined;
      checking = false;
      if (again && !disposed) {
        again = false;
        void authorize();
      }
    }
  };
  const schedule = () => {
    if (disposed || reconnect) return;
    disconnect();
    reconnect = setTimeout(() => {
      reconnect = undefined;
      connect();
    }, retry);
    retry = Math.min(15_000, retry * 2);
  };
  const connect = () => {
    if (disposed) return;
    let current: StudentSecuritySocketV1;
    const startedAt = Date.now(),
      version = noticeVersion;
    let acknowledged = false;
    try {
      connectionId = attemptRenewal ? crypto.randomUUID() : undefined;
      current = options.connect(connectionId);
    } catch {
      schedule();
      return;
    }
    socket = current;
    /** The first valid handshake: renewal support, then the lease it grants or an HTTP check. */
    function acceptHandshake(value: Record<string, unknown>) {
      const handshake = securityHandshakeV1(value);
      if (!handshake) return;
      acknowledged = true;
      if (handshake.supportsRenewal) {
        renewable = true;
        clearTimeout(rotation);
      }
      // An older handshake cannot override a security event or a newer HTTP observation.
      if (version !== noticeVersion || startedAt < lastHttpStartedAt) return;
      const leaseUntil = options.onAuthorized ? handshakeLeaseV1(handshake, startedAt) : null;
      if (leaseUntil && options.onAuthorized) {
        if (options.onAuthorized(leaseUntil, startedAt)) renew(startedAt);
      } else void authorize(); // Older servers retain the session-only compatibility path.
    }
    // Rotate even a stalled handshake; authorization never depends on receiving onclose.
    rotation = setTimeout(() => {
      disconnect();
      connect();
    }, 45_000);
    current.onopen = () => {
      if (disposed || socket !== current) return;
      retry = 1000;
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        try {
          current.send('security-ping');
        } catch {
          schedule();
        }
      }, 20_000);
    };
    current.onmessage = ({ data }) => {
      if (disposed || socket !== current) return;
      const value = securityMessageV1(data);
      if (!value) return;
      if (value.type === 'reauthorize' && Object.keys(value).length === 2) {
        noticeVersion++;
        void authorize(true);
      }
      if (value.type === 'security-connected' && !acknowledged) acceptHandshake(value);
    };
    current.onclose = current.onerror = () => {
      if (!disposed && socket === current) {
        // Older deployments can reject unknown query parameters before acknowledging.
        // Retry their unchanged URL and retain the existing rotation protocol.
        if (!acknowledged) attemptRenewal = false;
        schedule();
      }
    };
  };
  renew();
  connect();
  return { dispose };
}

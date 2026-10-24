import type { z } from 'zod';
import {
  activateRequestV1,
  challengeRequestV1,
  challengeResponseV1,
  loginRequestV1,
  logoutRequestV1,
  logoutResponseV1,
  sessionResponseV1,
} from '../../../../shared/student-portal-contracts/auth-v1';
import { selfResponseV1 } from '../../../../shared/student-portal-contracts/self-v1';
import {
  createPortalTransportV1,
  isAmbiguousPortalResponseV1,
  PortalClientErrorV1,
  portalRequestBodyV1,
  type PortalTransportOptionsV1,
} from './transport-v1';

export function createPortalSelfClientV1(options: PortalTransportOptionsV1 = {}) {
  const send = createPortalTransportV1({ ...options, respectRetryAfter: true, acceptAccessClosed: true });
  const confirmOnce = async <T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    try {
      return await request();
    } catch (error) {
      signal?.throwIfAborted();
      if (!isAmbiguousPortalResponseV1(error)) throw error;
      return request();
    }
  };
  const challenge = (input: z.input<typeof challengeRequestV1>, signal?: AbortSignal) => {
    const body = portalRequestBodyV1(challengeRequestV1, input);
    return confirmOnce(
      () => send('/api/student/auth/challenge', challengeResponseV1, signal, body),
      signal,
    );
  };
  const login = async (input: z.input<typeof loginRequestV1>, signal?: AbortSignal) => {
    const body = portalRequestBodyV1(loginRequestV1, input);
    const request = () => send('/api/student/auth/login', sessionResponseV1, signal, body);
    try {
      return await request();
    } catch (error) {
      signal?.throwIfAborted();
      if (!isAmbiguousPortalResponseV1(error)) throw error;
      try {
        // A committed login can set the HttpOnly cookie even when its response body is lost.
        // Confirm that state before repeating a session-creating command.
        return await send('/api/student/session', sessionResponseV1, signal);
      } catch (confirmationError) {
        signal?.throwIfAborted();
        if (
          !(confirmationError instanceof PortalClientErrorV1) ||
          confirmationError.state !== 'unauthenticated'
        )
          throw confirmationError;
      }
      return request();
    }
  };
  return {
    session: (signal?: AbortSignal, expectedAccountId?: string, connectionId?: string) => {
      // The connection only narrows an expected account; alone it is not sent.
      let query = '';
      if (expectedAccountId) {
        query = '?accountId=' + encodeURIComponent(expectedAccountId);
        if (connectionId) query += '&connectionId=' + encodeURIComponent(connectionId);
      }
      return send('/api/student/session' + query, sessionResponseV1, signal);
    },
    me: (signal?: AbortSignal) => send('/api/student/me', selfResponseV1, signal),
    challenge,
    activate: (input: z.input<typeof activateRequestV1>, signal?: AbortSignal) =>
      send(
        '/api/student/auth/activate',
        sessionResponseV1,
        signal,
        portalRequestBodyV1(activateRequestV1, input),
      ),
    login,
    logout: (signal?: AbortSignal) => {
      const body = portalRequestBodyV1(logoutRequestV1, { contractVersion: 1 });
      return confirmOnce(
        () => send('/api/student/auth/logout', logoutResponseV1, signal, body),
        signal,
      );
    },
  };
}
export type PortalSelfClientV1 = ReturnType<typeof createPortalSelfClientV1>;

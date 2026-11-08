import { createContext, createElement, type ReactNode } from 'react';
import { useRemoteLiveV1, type RemoteLiveStateV1 } from './use-remote-live-v1';

const AdministrativeLiveContextV1 = createContext<RemoteLiveStateV1 | null>(null);

/** The authenticated Admin shell owns one connection for Bank and Portal consumers.
 * An optional live channel never creates privileges or replaces the authorized read response.
 */
export function AdministrativeLiveProviderV1({ identityKey, enabled, onAuthorizationLost, children }: {
  readonly identityKey?: string;
  readonly enabled: boolean;
  readonly onAuthorizationLost?: () => void;
  readonly children: ReactNode;
}) {
  const state = useRemoteLiveV1({
    path: '/api/student-portal/admin/live',
    enabled: enabled && Boolean(identityKey),
    identityKey,
    onAuthorizationLost,
  });
  return createElement(AdministrativeLiveContextV1.Provider, { value: state }, children);
}

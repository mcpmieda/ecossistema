import { useEffect, useRef, useState } from 'react';
import type { SelfResponseV1 } from '../../../../shared/student-portal-contracts/self-v1';
import {
  createPortraitClientV1,
  type PortraitClientV1,
  type PortraitObjectV1,
} from './portrait-client-v1';

const defaultClient = createPortraitClientV1();
const dispose = (photo: PortraitObjectV1 | undefined) => {
  try {
    photo?.dispose();
  } catch {
    /* Optional media cleanup cannot interrupt logout. */
  }
};
export type PortraitScopeV1 = Pick<SelfResponseV1, 'requestId'> & {
  profile: Pick<SelfResponseV1['profile'], 'accountId'>;
};

/** No polling, persistence, focus listener, session transition or academic dependency. */
export function useStudentPortraitV1(
  self: PortraitScopeV1 | null,
  client: PortraitClientV1 = defaultClient,
): string | undefined {
  const accountId = self?.profile.accountId;
  const requestId = self?.requestId;
  const [shown, setShown] = useState<{
    accountId: string;
    client: PortraitClientV1;
    photo: PortraitObjectV1;
  }>();
  const held = useRef<PortraitObjectV1 | undefined>(undefined);
  // The signed-in account owns the photo on screen: another account or a logout releases it at once.
  useEffect(
    () => () => {
      dispose(held.current);
      held.current = undefined;
      setShown(undefined);
    },
    [accountId, client],
  );
  useEffect(() => {
    if (!accountId || !requestId) return;
    const controller = new AbortController();
    let current = true;
    // StrictMode's abandoned initial setup must not cause a duplicate network download.
    void Promise.resolve()
      .then(() => (controller.signal.aborted ? undefined : client(accountId, controller.signal)))
      .then((value) => {
        if (!current) {
          dispose(value);
          return;
        }
        // A new read of the same account keeps the current photo until its answer arrives.
        const previous = held.current;
        held.current = value;
        setShown(value ? { accountId, client, photo: value } : undefined);
        dispose(previous);
      })
      .catch(() => undefined);
    return () => {
      current = false;
      controller.abort();
    };
  }, [accountId, requestId, client]);
  return accountId && shown?.accountId === accountId && shown.client === client
    ? shown.photo.src
    : undefined;
}

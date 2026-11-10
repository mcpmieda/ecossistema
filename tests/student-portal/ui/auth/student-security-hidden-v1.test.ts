import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStudentSecurityV1,
  type StudentSecuritySocketV1,
} from '../../../../src/features/student-portal/auth/student-security-v1';
import { NOW, SESSION } from './fixtures-v1';

class Socket implements StudentSecuritySocketV1 {
  onopen: StudentSecuritySocketV1['onopen'] = null;
  onmessage: StudentSecuritySocketV1['onmessage'] = null;
  onclose: StudentSecuritySocketV1['onclose'] = null;
  onerror: StudentSecuritySocketV1['onerror'] = null;
  send = vi.fn();
  close = vi.fn();
  confirm() {
    this.onopen?.(new Event('open'));
    this.onmessage?.({
      data: JSON.stringify({ contractVersion: 1, type: 'security-connected', expiresAt: SESSION.expiresAt, renewable: true }),
    } as MessageEvent);
  }
}
let visibility: DocumentVisibilityState = 'visible';
const show = (state: DocumentVisibilityState) => {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup() {
  const sockets: Socket[] = [];
  const authorize = vi.fn<(signal: AbortSignal, connectionId?: string) => Promise<boolean>>().mockResolvedValue(true);
  const security = createStudentSecurityV1({
    connect: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    authorize,
    onAuthorized: () => true,
  });
  return { sockets, authorize, security };
}

describe('student security channel on a hidden page', () => {
  it('stops the channel and every check after thirty hidden seconds', async () => {
    const s = setup();
    s.sockets[0]!.confirm();
    show('hidden');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(s.sockets[0]!.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.sockets[0]!.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(s.authorize).not.toHaveBeenCalled();
    expect(s.sockets).toHaveLength(1);
    // Only the ping of the twenty seconds before the pause.
    expect(s.sockets[0]!.send).toHaveBeenCalledTimes(1);
    s.security.dispose();
  });
  it('checks the session at once and reconnects when a long-hidden page is shown again', async () => {
    const s = setup();
    s.sockets[0]!.confirm();
    show('hidden');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    show('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.authorize).toHaveBeenCalledTimes(1);
    expect(s.sockets).toHaveLength(2);
    // The usual rhythm is back: the new socket is renewed 45 s after that check.
    s.sockets[1]!.confirm();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(s.authorize).toHaveBeenCalledTimes(2);
    expect(s.authorize.mock.calls[1]![1]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(s.sockets).toHaveLength(2);
    s.security.dispose();
  });
  it('keeps the same socket and rhythm through a quick change of tab', async () => {
    const s = setup();
    s.sockets[0]!.confirm();
    show('hidden');
    await vi.advanceTimersByTimeAsync(20_000);
    show('visible');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(s.sockets).toHaveLength(1);
    expect(s.sockets[0]!.close).not.toHaveBeenCalled();
    expect(s.authorize).toHaveBeenCalledTimes(1);
    s.security.dispose();
  });
  it('waits for the rest of a recent lease when shown again soon after pausing', async () => {
    const s = setup();
    s.sockets[0]!.confirm();
    show('hidden');
    await vi.advanceTimersByTimeAsync(40_000);
    show('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.sockets).toHaveLength(2);
    expect(s.authorize).not.toHaveBeenCalled();
    // Sixty seconds after the last confirmation, with no new handshake, the HTTP check is due.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.authorize).toHaveBeenCalledTimes(1);
    s.security.dispose();
  });
  it('a page opened hidden pauses, and a disposed channel ignores the page', async () => {
    visibility = 'hidden';
    const s = setup();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.sockets[0]!.close).toHaveBeenCalledTimes(1);
    s.security.dispose();
    show('visible');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(s.sockets).toHaveLength(1);
    expect(s.authorize).not.toHaveBeenCalled();
  });
  it('lets a check already on its way finish without reconnecting the paused channel', async () => {
    const s = setup();
    s.sockets[0]!.confirm();
    let finish: (renewed: boolean) => void = () => {};
    s.authorize.mockReturnValueOnce(new Promise<boolean>((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(20_000);
    show('hidden');
    await vi.advanceTimersByTimeAsync(25_000); // the 45 s renewal starts, five seconds before the pause
    expect(s.authorize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s.sockets[0]!.close).toHaveBeenCalledTimes(1);
    finish(false); // not renewed: a page on screen would reconnect
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(s.sockets).toHaveLength(1);
    expect(s.authorize).toHaveBeenCalledTimes(1);
    show('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.sockets).toHaveLength(2);
    expect(s.authorize).toHaveBeenCalledTimes(2);
    s.security.dispose();
  });
});

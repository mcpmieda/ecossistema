import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudentPortalApp } from '../../../src/student-portal/app';
import { createPortalSelfClientV1 } from '../../../src/features/student-portal/shared/self-client-v1';
import {
  SYNTHETIC_ID_V1,
  SYNTHETIC_SELF_V1,
} from '../../../shared/student-portal-contracts/fixtures-v1';
import { setupOperationsDomV1 } from '../ui/overview/dom-v1';

beforeEach(() => {
  setupOperationsDomV1();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  'moves keyboard focus into content without history or session reload (authenticated=%s)',
  async (authenticated) => {
    const paths: string[] = [];
    const meta = { contractVersion: 1, requestId: SYNTHETIC_ID_V1 };
    const client = createPortalSelfClientV1({
      fetch: async (path) => {
        paths.push(path);
        const session = path === '/api/student/session';
        return new Response(
          JSON.stringify(
            session
              ? {
                  ...meta,
                  state: authenticated ? 'authenticated' : 'unauthenticated',
                  ...(authenticated
                    ? {
                        persistent: false,
                        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
                      }
                    : {}),
                }
              : SYNTHETIC_SELF_V1,
          ),
          {
            status: session && !authenticated ? 401 : 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          },
        );
      },
    });
    render(<StudentPortalApp client={client} />);
    const skip = await screen.findByRole('link', { name: 'Ir para o conteúdo' });
    const main = screen.getByRole('main');
    const initialPaths = [...paths];
    const historyLength = window.history.length;
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(skip);
    await user.keyboard('{Enter}');
    expect(document.activeElement).toBe(main);
    expect(window.location.hash).toBe('');
    expect(window.history).toHaveLength(historyLength);
    expect(paths).toEqual(initialPaths);
    expect(screen.getByRole('main')).toBe(main);
  },
);

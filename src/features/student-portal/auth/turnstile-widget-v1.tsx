import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';

interface TurnstileApiV1 {
  render(container: HTMLElement, options: Record<string, unknown>): string | undefined;
  remove(id: string): void;
}
type RiskCallbacksV1 = {
  token: (token: string) => void;
  unavailable: () => void;
  expired: () => void;
};
export type RiskMountV1 = (
  container: HTMLElement,
  sitekey: string,
  callbacks: RiskCallbacksV1,
) => () => void;
declare global {
  interface Window {
    turnstile?: TurnstileApiV1;
  }
}

/** Public sitekey only. The widget's single-use token is verified by the existing server. */
export const mountTurnstileV1: RiskMountV1 = (container, sitekey, callbacks) => {
  let disposed = false,
    widget: string | undefined,
    script: HTMLScriptElement | undefined;
  const fail = () => {
    if (!disposed) callbacks.unavailable();
  };
  const render = () => {
    if (disposed) return;
    if (!window.turnstile) {
      fail();
      return;
    }
    try {
      widget = window.turnstile.render(container, {
        sitekey,
        action: 'student_portal_auth',
        size: 'flexible',
        language: 'pt-BR',
        'response-field': false,
        retry: 'never',
        'refresh-expired': 'never',
        'refresh-timeout': 'never',
        callback: (token: string) => {
          if (!disposed) {
            clearTimeout(timer);
            callbacks.token(token);
          }
        },
        'error-callback': fail,
        'unsupported-callback': fail,
        'expired-callback': () => {
          if (!disposed) callbacks.expired();
        },
        'timeout-callback': () => {
          if (!disposed) callbacks.expired();
        },
      });
      if (!widget) fail();
    } catch {
      fail();
    }
  };
  const timer = setTimeout(fail, 120000);
  if (!sitekey || location.hostname !== 'aluno.escolaieda.com') fail();
  else if (window.turnstile) render();
  else {
    script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = render;
    script.onerror = fail;
    document.head.appendChild(script);
  }
  return () => {
    disposed = true;
    clearTimeout(timer);
    if (widget) window.turnstile?.remove(widget);
    script?.remove();
    container.replaceChildren();
  };
};

export function StudentRiskWidgetV1({
  sitekey,
  onToken,
  mount = mountTurnstileV1,
}: Readonly<{
  sitekey: string;
  onToken: (token: string | null) => void;
  mount?: RiskMountV1;
}>) {
  const container = useRef<HTMLDivElement>(null);
  const callback = useRef(onToken);
  callback.current = onToken;
  const [retry, setRetry] = useState(0);
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    callback.current(null);
    setMessage(undefined);
    return mount(container.current!, sitekey, {
      token: (token) => {
        setMessage(undefined);
        callback.current(token);
      },
      unavailable: () => {
        callback.current(null);
        setMessage('A verificação de segurança está indisponível.');
      },
      expired: () => {
        callback.current(null);
        setMessage('A verificação terminou. Faça uma nova verificação.');
      },
    });
  }, [sitekey, mount, retry]);
  return (
    <div className="pa-risk-widget">
      <div ref={container} aria-label="Verificação de segurança" />
      {message ? (
        <div role="alert">
          <p>{message}</p>
          <Button size="sm" variant="secondary" onPress={() => setRetry((v) => v + 1)}>
            Verificar novamente
          </Button>
        </div>
      ) : null}
    </div>
  );
}

import { StrictMode, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { StudentAuthenticationV1 } from '../features/student-portal/auth/student-auth-v1';
import type { RiskMountV1 } from '../features/student-portal/auth/turnstile-widget-v1';
import {
  StudentEntryLayoutV1,
  StudentSplashV1,
} from '../features/student-portal/auth/student-entry-layout-v1';
import { PortalClosedNoticeV1 } from '../features/student-portal/shell/portal-notices-v1';
import { createPortalSelfClientV1 } from '../features/student-portal/shared/self-client-v1';
import { PORTAL_ORIGIN_V1 } from '../../shared/student-portal-contracts/core-v1';
import '../features/student-portal/shared/styles.css';
import { scalarTextV1 } from '../../shared/scalar-text-v1';

/*
 * Login preview only. The real sign-in screens and flow run against an invented in-browser
 * server (no network, no real account, no Turnstile). Every screen is listed so it can be
 * reviewed one by one; screens that only appear after typing are reached by filling the form
 * automatically. Nothing here ships in the Portal bundle (index.html never loads it).
 */
const PREVIEW_QR_V1 = `${PORTAL_ORIGIN_V1}/access#v1.${'A'.repeat(32)}.1.${'B'.repeat(43)}`;
const requestId = '11111111-1111-4111-8111-111111111111';

type ChallengeV1 =
  | 'pin'
  | 'password'
  | 'risk'
  | 'create'
  | 'create-expiring'
  | 'unauthenticated'
  | 'rate-limited'
  | 'unavailable'
  | 'network'
  | 'slow';
type LoginV1 = 'ok' | 'unauthenticated' | 'rate-limited' | 'slow';
interface ScreenV1 {
  label: string;
  /** What the invented server answers to the QR (challenge) and to the password (login). */
  challenge?: ChallengeV1;
  login?: LoginV1;
  /** Start as if this QR had just been read (undefined: start on the card screen). */
  qr?: string;
  camera?: 'allowed' | 'denied';
  /** Digits typed and submitted by the preview itself, to reach screens after a try. */
  type?: readonly string[];
  submit?: boolean;
  splash?: 'checking' | 'entered';
  /** Portal closed by the school: what to count down to (relative to now). */
  closed?: 'grades' | 'opening' | 'none';
}
const SCREENS_V1: readonly ScreenV1[] = [
  { label: 'Cartão: ler o QR', camera: 'allowed' },
  { label: 'Cartão: câmera bloqueada', camera: 'denied' },
  { label: 'Cartão: lendo o QR (carregando)', challenge: 'slow', qr: PREVIEW_QR_V1 },
  { label: 'Cartão: QR inválido', qr: `${PORTAL_ORIGIN_V1}/access#invalido` },
  // A well-formed card the server refuses (unknown, replaced or blocked): no numbers were typed yet.
  { label: 'Cartão: não reconhecido (recusado)', challenge: 'unauthenticated', qr: PREVIEW_QR_V1 },
  { label: 'Primeiro acesso: ano de nascimento', challenge: 'pin', qr: PREVIEW_QR_V1 },
  {
    label: 'Primeiro acesso: ano errado',
    challenge: 'pin',
    qr: PREVIEW_QR_V1,
    type: ['1999'],
    submit: true,
  },
  { label: 'Criar senha', challenge: 'create', qr: PREVIEW_QR_V1 },
  {
    label: 'Criar senha: senhas diferentes',
    challenge: 'create',
    qr: PREVIEW_QR_V1,
    type: ['123456', '123450'],
    submit: true,
  },
  { label: 'Criar senha: prazo terminou', challenge: 'create-expiring', qr: PREVIEW_QR_V1 },
  { label: 'Senha: digitar a senha', challenge: 'password', qr: PREVIEW_QR_V1 },
  {
    label: 'Senha: entrando (carregando)',
    challenge: 'password',
    login: 'slow',
    qr: PREVIEW_QR_V1,
    type: ['123456'],
    submit: true,
  },
  {
    label: 'Senha: não deu certo',
    challenge: 'password',
    login: 'unauthenticated',
    qr: PREVIEW_QR_V1,
    type: ['999999'],
    submit: true,
  },
  {
    label: 'Senha: muitas tentativas (contagem)',
    challenge: 'password',
    login: 'rate-limited',
    qr: PREVIEW_QR_V1,
    type: ['999999'],
    submit: true,
  },
  { label: 'Verificação rápida', challenge: 'risk', qr: PREVIEW_QR_V1 },
  { label: 'Cartão: muitas tentativas (contagem)', challenge: 'rate-limited', qr: PREVIEW_QR_V1 },
  { label: 'Cartão: portal fora do ar', challenge: 'unavailable', qr: PREVIEW_QR_V1 },
  { label: 'Cartão: sem internet', challenge: 'network', qr: PREVIEW_QR_V1 },
  { label: 'Portal fechado: contagem para as notas', closed: 'grades' },
  { label: 'Portal fechado: data de abertura', closed: 'opening' },
  { label: 'Portal fechado: sem data', closed: 'none' },
  { label: 'Abertura: verificando acesso', splash: 'checking' },
  { label: 'Depois de entrar: Tudo certo!', splash: 'entered' },
];

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify({ contractVersion: 1, requestId, ...body }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
const failure = (state: string, retryAfterSeconds?: number) =>
  reply(
    { unauthenticated: 401, 'rate-limited': 429, unavailable: 503 }[state] ?? 400,
    { state, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
  );
const session = () =>
  reply(200, {
    state: 'authenticated',
    expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    persistent: true,
  });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Invented server: the same responses the Worker sends, chosen by the screen under review. */
function previewFetchV1(screen: ScreenV1): typeof fetch {
  let riskPassed = false;
  return async (input, init) => {
    const path = scalarTextV1(input);
    const body = init?.body ? (JSON.parse(scalarTextV1(init.body)) as Record<string, unknown>) : {};
    if (path === '/api/student/auth/challenge') {
      const challenge = screen.challenge ?? 'password';
      await wait(challenge === 'slow' ? 10 * 60_000 : 500);
      if (challenge === 'network') throw new TypeError('Failed to fetch');
      if (challenge === 'unavailable' || challenge === 'unauthenticated') return failure(challenge);
      if (challenge === 'rate-limited') return failure('rate-limited', 900);
      if (challenge === 'risk' && !body.riskToken && !riskPassed)
        return reply(200, { state: 'credential-required', next: 'risk' });
      if (challenge === 'risk') riskPassed = true;
      if (challenge === 'pin') {
        if (body.pin === undefined) return reply(200, { state: 'credential-required', next: 'pin' });
        return body.pin === '2012'
          ? reply(200, {
              state: 'password-creation',
              challenge: 'C'.repeat(43),
              expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            })
          : failure('unauthenticated');
      }
      if (challenge === 'create' || challenge === 'create-expiring')
        return reply(200, {
          state: 'password-creation',
          challenge: 'C'.repeat(43),
          expiresAt: new Date(Date.now() + (challenge === 'create' ? 10 * 60_000 : 2500)).toISOString(),
        });
      return reply(200, { state: 'credential-required', next: 'password' });
    }
    if (path === '/api/student/auth/login') {
      const login = screen.login ?? 'ok';
      await wait(login === 'slow' ? 10 * 60_000 : 500);
      if (login === 'unauthenticated') return failure('unauthenticated');
      if (login === 'rate-limited') return failure('rate-limited', 900);
      return body.password === '123456' ? session() : failure('unauthenticated');
    }
    if (path === '/api/student/auth/activate') {
      await wait(500);
      return session();
    }
    return failure('unauthenticated');
  };
}

/** Stands in for Cloudflare Turnstile: one button that yields a token. */
const previewRiskMountV1: RiskMountV1 = (container, _sitekey, callbacks) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Simular verificação (Turnstile)';
  button.style.cssText =
    'padding:10px 14px;border:1px dashed #64748b;border-radius:10px;background:#f8fafc;cursor:pointer;font:inherit';
  button.onclick = () => {
    button.textContent = '✓ Verificado';
    button.disabled = true;
    callbacks.token('preview-risk-token');
  };
  container.append(button);
  return () => button.remove();
};

/**
 * The pane blocks cameras, so the preview tells the page what the browser would report for each
 * screen. Set before the screen mounts, since the card screen asks on mount.
 */
function applyCameraPermissionV1(state: ScreenV1['camera']) {
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: async () => ({ state: state === 'denied' ? 'denied' : 'prompt' }) },
  });
}

/** A local video frame lets reviewers inspect the scanner without requesting a real camera. */
function installPreviewCameraV1() {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async (): Promise<MediaStream> => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const context = canvas.getContext('2d');
        if (!context) throw new DOMException('Preview canvas unavailable', 'NotFoundError');
        const background = context.createLinearGradient(0, 0, canvas.width, canvas.height);
        background.addColorStop(0, '#0d254b');
        background.addColorStop(1, '#087b9a');
        context.fillStyle = background;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.strokeStyle = '#8eeeff';
        context.lineWidth = 5;
        context.strokeRect(170, 90, 300, 300);
        context.fillStyle = '#ffffff';
        context.font = 'bold 25px system-ui';
        context.textAlign = 'center';
        context.fillText('PRÉVIA DA CÂMERA', 320, 55);
        context.font = '21px system-ui';
        context.fillText('Aponte o QR do cartão aqui', 320, 440);
        return canvas.captureStream(10);
      },
    },
  });
}

/** Types the given digits into the visible fields and presses the main button. */
async function playV1(screen: ScreenV1, run: number, current: () => number) {
  if (!screen.type?.length) return;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  for (let attempt = 0; attempt < 40 && current() === run; attempt++) {
    const inputs = document.querySelectorAll<HTMLInputElement>('.pa-credential-field input');
    if (inputs.length >= screen.type.length) {
      screen.type.forEach((digits, index) => {
        setValue.call(inputs[index], digits);
        inputs[index]!.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await wait(300);
      if (screen.submit && current() === run)
        document.querySelector<HTMLButtonElement>('.pa-auth-submit')?.click();
      return;
    }
    await wait(150);
  }
}

const panelStyle: CSSProperties = {
  position: 'fixed',
  bottom: 8,
  left: 8,
  zIndex: 200,
  maxWidth: 'calc(100vw - 16px)',
  padding: '8px 12px',
  borderRadius: 14,
  background: 'rgb(15 23 42 / 0.92)',
  color: 'white',
  font: '12px/1.4 system-ui, sans-serif',
  boxShadow: '0 10px 30px rgb(0 0 0 / 0.3)',
};
const rowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', margin: '6px 0' };

let runCounter = 0;

function LoginPreviewV1() {
  const [index, setIndex] = useState(0);
  const [run, setRun] = useState(0);
  const [authenticated, setAuthenticated] = useState(false);
  const screen = SCREENS_V1[index]!;
  const client = useMemo(
    () => createPortalSelfClientV1({ respectRetryAfter: true, fetch: previewFetchV1(screen) }),
    // A new client per visit also clears the transport's rate-limit cooldown.
    [screen, run],
  );
  useEffect(() => {
    runCounter += 1;
    const mine = runCounter;
    void playV1(screen, mine, () => runCounter);
  }, [screen, run]);
  const go = (next: number) => {
    const target = (next + SCREENS_V1.length) % SCREENS_V1.length;
    applyCameraPermissionV1(SCREENS_V1[target]!.camera);
    setAuthenticated(false);
    setIndex(target);
    setRun((value) => value + 1);
  };
  return (
    <>
      <details open style={panelStyle}>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>
          Telas do login ({index + 1}/{SCREENS_V1.length})
        </summary>
        <div style={rowStyle}>
          <button type="button" onClick={() => go(index - 1)}>
            ◀ Anterior
          </button>
          <select value={index} onChange={(event) => go(Number(event.target.value))}>
            {SCREENS_V1.map((item, position) => (
              <option key={item.label} value={position}>
                {position + 1}. {item.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => go(index + 1)}>
            Próxima ▶
          </button>
        </div>
        <div style={rowStyle}>
          <button type="button" onClick={() => go(index)}>
            Recomeçar esta tela
          </button>
          <span style={{ opacity: 0.75 }}>Ano: 2012 · Senha: 123456</span>
        </div>
      </details>
      {screen.closed ? (
        <StudentEntryLayoutV1>
          <PortalClosedNoticeV1
            key={`${index}-${run}`}
            notices={{
              access: 'closed',
              accessOpensAt:
                screen.closed === 'opening' ? new Date(Date.now() + 3 * 86_400_000).toISOString() : null,
              gradesReleaseAt:
                screen.closed === 'grades'
                  ? new Date(Date.now() + (86400 + 4 * 3600 + 25 * 60 + 9) * 1000).toISOString()
                  : null,
              disclosureEnded: null,
            }}
          />
        </StudentEntryLayoutV1>
      ) : screen.splash ? (
        <StudentSplashV1 entered={screen.splash === 'entered'} />
      ) : authenticated ? (
        <StudentSplashV1 entered />
      ) : (
        <StudentEntryLayoutV1>
          <StudentAuthenticationV1
            key={`${index}-${run}`}
            client={client}
            initialQr={screen.qr ?? null}
            onAuthenticated={() => setAuthenticated(true)}
            sitekey="preview"
            riskMount={previewRiskMountV1}
          />
        </StudentEntryLayoutV1>
      )}
    </>
  );
}

installPreviewCameraV1();
applyCameraPermissionV1(SCREENS_V1[0]!.camera);
const root = document.getElementById('root');
if (!root) throw new Error('Preview root missing');
createRoot(root).render(
  <StrictMode>
    <LoginPreviewV1 />
  </StrictMode>,
);

import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudentAuthenticationV1 } from '../../../../src/features/student-portal/auth/student-auth-v1';
import {
  StudentRiskWidgetV1,
  type RiskMountV1,
} from '../../../../src/features/student-portal/auth/turnstile-widget-v1';
import { useStudentSessionV1 } from '../../../../src/features/student-portal/auth/student-session-v1';
import { StudentQrReaderV1 } from '../../../../src/features/student-portal/auth/qr-reader-v1';
import * as qrMediaV1 from '../../../../src/features/student-portal/auth/qr-media-v1';
import { QrInputErrorV1 } from '../../../../src/features/student-portal/auth/qr-input-v1';
import { SYNTHETIC_QR_V1 } from '../../../../shared/student-portal-contracts/fixtures-v1';
import { clientFixtureV1, NOW, PROOF, REQUIRED, SESSION } from './fixtures-v1';
import { PortalClientErrorV1 } from '../../../../src/features/student-portal/shared/transport-v1';
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
// input-otp schedules short timers (up to 50 ms) that call setState; if one fires after this file
// tears down jsdom, React throws "window is not defined" as an unhandled error and fails CI.
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
});
function view(client = clientFixtureV1(), initialQr: string | null = SYNTHETIC_QR_V1) {
  const success = vi.fn();
  render(
    createElement(StudentAuthenticationV1, {
      client,
      onAuthenticated: success,
      initialQr,
      sitekey: 'synthetic-sitekey',
    }),
  );
  return { client, success, user: userEvent.setup() };
}
describe('student authentication forms', () => {
  it('shows access closed after the QR is checked without blaming the student credentials', async () => {
    const client = clientFixtureV1();
    client.challenge.mockRejectedValueOnce(new PortalClientErrorV1('access-closed', 403));
    view(client);
    expect((await screen.findByRole('alert')).textContent).toContain('Acesso ao Portal fechado');
    expect(screen.queryByText('Não deu certo')).toBeNull();
  });
  it('says the card was not recognised, not to check numbers, when the QR is refused', async () => {
    const client = clientFixtureV1();
    client.challenge.mockRejectedValueOnce(new PortalClientErrorV1('unauthenticated', 401));
    view(client);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Cartão não reconhecido');
    expect(alert.textContent).not.toContain('Confira os números');
  });
  it('distinguishes an invalid gallery QR from a card refused by the server and allows another image', async () => {
    vi.spyOn(qrMediaV1, 'readQrImageV1')
      .mockRejectedValueOnce(new QrInputErrorV1('invalid'))
      .mockResolvedValueOnce(SYNTHETIC_QR_V1);
    const client = clientFixtureV1();
    client.challenge.mockRejectedValueOnce(new PortalClientErrorV1('unauthenticated', 401));
    const s = view(client, null);
    const file = new File(['synthetic-image'], 'synthetic.png', { type: 'image/png' });
    await s.user.upload(screen.getByLabelText('Imagem do QR'), file);
    expect((await screen.findByRole('alert')).textContent).toBe('Este QR não é um acesso válido ao Portal.');
    expect(client.challenge).not.toHaveBeenCalled();
    await s.user.upload(screen.getByLabelText('Imagem do QR'), file);
    expect((await screen.findByRole('alert')).textContent).toContain('Cartão não reconhecido');
    expect(screen.getByRole('alert').textContent).not.toContain('Confira os números');
    expect(client.challenge).toHaveBeenCalledOnce();
  });
  it('asks to read the QR again after a refused activation without declaring the card invalid', async () => {
    const client = clientFixtureV1();
    client.challenge.mockResolvedValueOnce(PROOF);
    client.activate.mockRejectedValueOnce(new PortalClientErrorV1('unauthenticated', 401));
    const s = view(client);
    await s.user.type(await screen.findByLabelText('Nova senha'), '482913');
    await s.user.type(screen.getByLabelText('Confirmar senha'), '482913');
    await s.user.click(screen.getByRole('button', { name: 'Criar senha e entrar' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Leia o QR novamente');
    expect(alert.textContent).not.toContain('Cartão não reconhecido');
    expect(screen.getByRole('button', { name: 'Selecionar QR da galeria' })).toBeTruthy();
  });
  it('does not call a newly required security check a failed verification after a wrong password', async () => {
    const client = clientFixtureV1();
    client.challenge.mockResolvedValueOnce(REQUIRED('password')).mockResolvedValueOnce(REQUIRED('risk'));
    client.login.mockRejectedValueOnce(new PortalClientErrorV1('unauthenticated', 401));
    render(createElement(StudentAuthenticationV1, {
      client,
      onAuthenticated: vi.fn(),
      initialQr: SYNTHETIC_QR_V1,
      sitekey: 'synthetic-sitekey',
      riskMount: () => () => undefined,
    }));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Senha de 6 números'), '482913');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('heading', { name: 'Verificação rápida' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('keeps the verification error when the security check itself is refused', async () => {
    const client = clientFixtureV1();
    client.challenge.mockResolvedValueOnce(REQUIRED('risk'))
      .mockRejectedValueOnce(new PortalClientErrorV1('unauthenticated', 401));
    let callbacks!: Parameters<RiskMountV1>[2];
    render(createElement(StudentAuthenticationV1, {
      client,
      onAuthenticated: vi.fn(),
      initialQr: SYNTHETIC_QR_V1,
      sitekey: 'synthetic-sitekey',
      riskMount: (_container, _key, next) => {
        callbacks = next;
        return () => undefined;
      },
    }));
    await screen.findByRole('heading', { name: 'Verificação rápida' });
    await waitFor(() => expect(callbacks).toBeDefined());
    act(() => callbacks.token('synthetic-risk-token'));
    expect((await screen.findByRole('alert')).textContent).toContain('A verificação não foi concluída');
  });
  it.each([
    ['NotAllowedError', 'Você bloqueou a câmera'],
    ['NotFoundError', 'Nenhuma câmera disponível'],
    ['NotReadableError', 'Não foi possível usar a câmera'],
  ])('offers local-image fallback when camera returns %s', async (name, message) => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockRejectedValue(new DOMException('synthetic-camera-error', name)),
      },
    });
    try {
      render(createElement(StudentQrReaderV1, { onQr: vi.fn() }));
      await userEvent.setup().click(screen.getByRole('button', { name: 'Ler QR com câmera' }));
      expect((await screen.findByRole('alert')).textContent).toContain(message);
      expect(
        (screen.getByRole('button', { name: 'Selecionar QR da galeria' }) as HTMLButtonElement).disabled,
      ).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'mediaDevices', descriptor);
      else Reflect.deleteProperty(navigator, 'mediaDevices');
    }
  });
  it('accepts paste/leading zero, leaves keep connected off by default and sends the explicit choice', async () => {
    const client = clientFixtureV1();
    client.challenge.mockResolvedValueOnce(REQUIRED('password'));
    const s = view(client);
    const password = await screen.findByLabelText('Senha de 6 números');
    await s.user.click(password);
    await s.user.paste('001234');
    expect((password as HTMLInputElement).value).toBe('001234');
    const keep = screen.getByRole('checkbox', { name: 'Manter conectado neste celular' });
    expect((keep as HTMLInputElement).checked).toBe(false);
    await s.user.click(keep);
    await s.user.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(s.success).toHaveBeenCalledOnce());
    expect(client.login.mock.calls[0]?.[0]).toMatchObject({
      password: '001234',
      keepConnected: true,
    });
    expect(screen.queryByLabelText('Senha de 6 números')).toBeNull();
  });
  it('renders PIN4 and password6 in two groups, blocks mismatched confirmation', async () => {
    const s = view();
    const pin = await screen.findByLabelText('Ano de nascimento do aluno');
    expect(document.querySelectorAll('[data-slot="input-otp-slot"]')).toHaveLength(4);
    await s.user.type(pin, '0001');
    s.client.challenge.mockResolvedValueOnce(PROOF);
    await s.user.click(screen.getByRole('button', { name: 'Continuar' }));
    const password = await screen.findByLabelText('Nova senha'),
      confirmation = screen.getByLabelText('Confirmar senha');
    expect(document.querySelectorAll('[data-slot="input-otp-separator"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-slot="input-otp-slot"]')).toHaveLength(12);
    await s.user.type(password, '00123');
    expect(document.activeElement).toBe(password);
    await s.user.keyboard('4');
    await waitFor(() => expect(document.activeElement).toBe(confirmation));
    await s.user.keyboard('001235');
    // Creating a password shows both fields so the student can compare them.
    expect(document.querySelectorAll('[data-masked]')).toHaveLength(0);
    await s.user.click(screen.getByRole('button', { name: 'Criar senha e entrar' }));
    expect(screen.getByRole('alert').textContent).toContain('As senhas precisam ser iguais');
    expect(s.client.activate).not.toHaveBeenCalled();
    await s.user.clear(confirmation);
    await s.user.type(confirmation, '001234');
    await s.user.click(screen.getByRole('button', { name: 'Criar senha e entrar' }));
    await waitFor(() => expect(s.success).toHaveBeenCalledOnce());
  });
  it('on a computer, Enter goes on after the last digit and the next step is ready to type (owner report 23/10/2026)', async () => {
    const s = view();
    const pin = await screen.findByLabelText('Ano de nascimento do aluno');
    // The first step takes the focus by itself.
    await waitFor(() => expect(document.activeElement).toBe(pin));
    s.client.challenge.mockResolvedValueOnce(PROOF);
    await s.user.keyboard('0001');
    // The last digit hands the focus to the button: Enter goes on.
    const proceed = screen.getByRole('button', { name: 'Continuar' });
    await waitFor(() => expect(document.activeElement).toBe(proceed));
    await s.user.keyboard('{Enter}');
    // The next step's field is ready to type, with no click.
    const password = await screen.findByLabelText('Nova senha');
    await waitFor(() => expect(document.activeElement).toBe(password));
  });
  it('refuses an easy password at once, without spending a try', async () => {
    const s = view();
    await s.user.type(await screen.findByLabelText('Ano de nascimento do aluno'), '0001');
    s.client.challenge.mockResolvedValueOnce(PROOF);
    await s.user.click(screen.getByRole('button', { name: 'Continuar' }));
    const password = await screen.findByLabelText('Nova senha');
    expect(screen.getByText(/Evite números repetidos ou em sequência/u)).toBeTruthy();
    await s.user.type(password, '123456');
    await s.user.type(screen.getByLabelText('Confirmar senha'), '123456');
    await s.user.click(screen.getByRole('button', { name: 'Criar senha e entrar' }));
    expect(screen.getByRole('alert').textContent).toContain('Essa senha é fácil de adivinhar');
    expect(s.client.activate).not.toHaveBeenCalled();
  });
  it('rejects non-ASCII and clears sensitive fields when cancelled or hidden', async () => {
    const s = view();
    const pin = await screen.findByLabelText('Ano de nascimento do aluno');
    await s.user.click(pin);
    await s.user.paste('１２３４');
    expect((pin as HTMLInputElement).value).toBe('');
    await s.user.type(pin, '0001');
    await s.user.click(screen.getByRole('button', { name: 'Usar outro cartão' }));
    expect(screen.queryByLabelText('Ano de nascimento do aluno')).toBeNull();
    expect(screen.getByRole('button', { name: 'Ler QR com câmera' })).toBeTruthy();
  });
  it('handles risk expiry/failure and disposes every widget on retry or unmount', async () => {
    const token = vi.fn(),
      dispose = vi.fn();
    let callbacks!: Parameters<RiskMountV1>[2];
    const mount = vi.fn<RiskMountV1>((_container, _key, next) => {
      callbacks = next;
      return dispose;
    });
    const component = render(
      createElement(StudentRiskWidgetV1, { sitekey: 'synthetic', onToken: token, mount }),
    );
    act(() => callbacks.token('synthetic-token'));
    expect(token).toHaveBeenLastCalledWith('synthetic-token');
    act(() => callbacks.expired());
    expect(token).toHaveBeenLastCalledWith(null);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Verificar novamente' }));
    expect(dispose).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledTimes(2);
    act(() => callbacks.unavailable());
    expect(screen.getByRole('alert').textContent).toContain('indisponível');
    component.unmount();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
  it('clears the DOM on pagehide and reloads a verified copy after pageshow', async () => {
    const client = clientFixtureV1();
    function SessionView() {
      const { load } = useStudentSessionV1(client);
      return createElement(
        'div',
        null,
        load.state === 'ready' ? load.data.profile.name : load.state,
      );
    }
    render(createElement(SessionView));
    await screen.findByText('Estudante de exemplo');
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(screen.queryByText('Estudante de exemplo')).toBeNull();
    // Never restored from the frozen page: shown again only after a fresh session + read.
    act(() => {
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(screen.queryByText('Estudante de exemplo')).toBeNull();
    await screen.findByText('Estudante de exemplo');
    expect(client.session).toHaveBeenCalledTimes(2);
    expect(client.me).toHaveBeenCalledTimes(2);
  });
});

it('keeps the password form mounted while the first submission is pending and sends every digit once', async () => {
  const client = clientFixtureV1();
  client.challenge.mockResolvedValueOnce(REQUIRED('password'));
  let finish!: (result: Awaited<ReturnType<typeof client.login>>) => void;
  const result = SESSION;
  client.login.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const s = view(client);
  const password = await screen.findByLabelText('Senha de 6 números');
  await s.user.type(password, '001234');
  await s.user.click(screen.getByRole('button', { name: 'Entrar' }));
  expect(screen.getByLabelText('Senha de 6 números')).toBe(password);
  expect(screen.queryByText('Verificando acesso')).toBeNull();
  expect(screen.getByRole('button', { name: 'Entrando…' }).hasAttribute('disabled')).toBe(true);
  expect(client.login).toHaveBeenCalledOnce();
  expect(client.login.mock.calls[0]?.[0]).toMatchObject({ password: '001234' });
  await act(async () => finish(result));
  expect(s.success).toHaveBeenCalledOnce();
});

it('shows only the digit just typed, then masks it after a pause, on deletion and on blur', async () => {
  const client = clientFixtureV1();
  client.challenge.mockResolvedValueOnce(REQUIRED('password'));
  const s = view(client);
  const password = await screen.findByLabelText('Senha de 6 números');
  const masks = () =>
    Array.from(document.querySelectorAll('[data-slot="input-otp-slot"]')).map((slot) =>
      slot.hasAttribute('data-masked'),
    );
  // Focused on arrival, so the phone opens its number keyboard at once.
  await waitFor(() => expect(document.activeElement).toBe(password));
  await s.user.type(password, '00123');
  expect(masks()).toEqual([true, true, true, true, false, true]);
  expect(password.getAttribute('type')).toBe('password');
  await act(() => new Promise((resolve) => setTimeout(resolve, 1300)));
  expect(masks().every(Boolean)).toBe(true);
  await s.user.keyboard('{Backspace}');
  expect(masks().every(Boolean)).toBe(true);
  await s.user.keyboard('9');
  expect(masks()).toEqual([true, true, true, true, false, true]);
  await s.user.tab();
  expect(masks().every(Boolean)).toBe(true);
  // The last digit completes the field: the keyboard closes and every digit is masked.
  await s.user.click(password);
  await s.user.keyboard('4');
  await waitFor(() => expect(document.activeElement).not.toBe(password));
  expect(masks().every(Boolean)).toBe(true);
});

it('keeps QR discovery on the entry card and offers another card during password creation', async () => {
  const client = clientFixtureV1();
  let finish!: (result: typeof PROOF) => void;
  client.challenge.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const s = view(client);
  expect(screen.getByRole('heading', { name: 'Acessar minhas notas' })).toBeTruthy();
  expect(screen.queryByText('Verificando acesso')).toBeNull();
  await act(async () => finish(PROOF));
  expect(screen.getByRole('button', { name: 'Usar outro cartão' })).toBeTruthy();
  await s.user.click(screen.getByRole('button', { name: 'Usar outro cartão' }));
  expect(screen.queryByLabelText('Nova senha')).toBeNull();
  expect(screen.getByRole('button', { name: 'Selecionar QR da galeria' })).toBeTruthy();
});

it('continues by itself once the security check passes, with no extra tap', async () => {
  const client = clientFixtureV1();
  client.challenge.mockResolvedValueOnce(REQUIRED('risk')).mockResolvedValueOnce(REQUIRED('password'));
  let callbacks!: Parameters<RiskMountV1>[2];
  const riskMount = vi.fn<RiskMountV1>((_container, _key, next) => {
    callbacks = next;
    return () => undefined;
  });
  render(
    createElement(StudentAuthenticationV1, {
      client,
      onAuthenticated: vi.fn(),
      initialQr: SYNTHETIC_QR_V1,
      sitekey: 'synthetic-sitekey',
      riskMount,
    }),
  );
  expect(await screen.findByRole('heading', { name: 'Verificação rápida' })).toBeTruthy();
  act(() => callbacks.token('synthetic-risk-token'));
  expect(await screen.findByLabelText('Senha de 6 números')).toBeTruthy();
  expect(client.challenge.mock.calls[1]?.[0]).toMatchObject({ riskToken: 'synthetic-risk-token' });
});

it('explains how to lift a camera the browser already reports as denied', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'permissions');
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: vi.fn().mockResolvedValue({ state: 'denied' }) },
  });
  try {
    render(createElement(StudentQrReaderV1, { onQr: vi.fn() }));
    expect(await screen.findByRole('heading', { name: 'Você bloqueou a câmera' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ler QR com câmera' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Selecionar QR da galeria' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar de novo com a câmera' })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'iPhone' }));
    expect(screen.getByText('Ajustes do Site')).toBeTruthy();
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'permissions', descriptor);
    else Reflect.deleteProperty(navigator, 'permissions');
  }
});

it('closes the number keyboard after the last digit so the buttons show', async () => {
  const s = view();
  const pin = await screen.findByLabelText('Ano de nascimento do aluno');
  await waitFor(() => expect(document.activeElement).toBe(pin));
  await s.user.type(pin, '2012');
  await waitFor(() => expect(document.activeElement).not.toBe(pin));
  expect(screen.getByRole('button', { name: 'Continuar' })).toBeTruthy();
});

it('lifts the blocked-camera help when the camera is allowed in the settings', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'permissions');
  const status = Object.assign(new EventTarget(), { state: 'denied' as PermissionState });
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: vi.fn().mockResolvedValue(status) },
  });
  try {
    render(createElement(StudentQrReaderV1, { onQr: vi.fn() }));
    expect(await screen.findByRole('heading', { name: 'Você bloqueou a câmera' })).toBeTruthy();
    act(() => {
      status.state = 'prompt';
      status.dispatchEvent(new Event('change'));
    });
    expect(screen.queryByRole('heading', { name: 'Você bloqueou a câmera' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ler QR com câmera' })).toBeTruthy();
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'permissions', descriptor);
    else Reflect.deleteProperty(navigator, 'permissions');
  }
});

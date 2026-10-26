import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@heroui/react/button';
import { CameraOff, ImageIcon, SlidersHorizontal } from 'lucide-react';
import { SCHOOL_LOGO_SRC_V1 } from '../../../shared/brand/school-mark-v1';
import { SCHOOL_CARD_NAME_LINES_V1 } from '../../../shared/brand/school-name-v1';
import {
  createCameraLeaseV1,
  createQrCameraDecoderV1,
  decodeQrFrameV1,
  readQrImageV1,
  type QrFrameDecoderV1,
} from './qr-media-v1';
import { QrInputErrorV1, selectStudentQrV1 } from './qr-input-v1';

const CAMERA_ASSIST_DELAY_MS_V1 = 2000;
const CAMERA_FRAME_GAP_MS_V1 = 120;

type NativeQrDetectorV1 = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };
/** The platform detector (Chrome on Android) copes with soft focus far better than jsQR. It runs
 * on the device; nothing leaves the browser.
 */
async function nativeQrDetectorV1(): Promise<NativeQrDetectorV1 | undefined> {
  const Detector = (
    globalThis as {
      BarcodeDetector?: (new (options: { formats: string[] }) => NativeQrDetectorV1) & {
        getSupportedFormats?: () => Promise<string[]>;
      };
    }
  ).BarcodeDetector;
  if (!Detector) return undefined;
  try {
    const formats = await Detector.getSupportedFormats?.();
    if (formats && !formats.includes('qr_code')) return undefined;
    return new Detector({ formats: ['qr_code'] });
  } catch {
    return undefined;
  }
}

/** Codes the platform detector finds in the frame; none when it is missing or fails. */
async function nativeCodesV1(
  native: NativeQrDetectorV1 | undefined,
  player: HTMLVideoElement,
): Promise<string[]> {
  if (!native) return [];
  try {
    return (await native.detect(player))
      .map((code) => code.rawValue)
      .filter((value) => typeof value === 'string' && value.length > 0);
  } catch {
    return [];
  }
}

/** Draws one step of the rotation: centre at full detail (0 and 1) or the whole frame (2). */
function drawCameraFrameV1(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  player: HTMLVideoElement,
  step: number,
  assisted: boolean,
) {
  const [width, height] = [player.videoWidth, player.videoHeight];
  if (step === 2) {
    const scale = Math.min(1, (assisted ? 1280 : 960) / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    context.drawImage(player, 0, 0, canvas.width, canvas.height);
    return;
  }
  const side = Math.round(Math.min(width, height) * 0.75);
  canvas.width = canvas.height = Math.min(side, 1024);
  context.drawImage(
    player,
    Math.round((width - side) / 2),
    Math.round((height - side) / 2),
    side,
    side,
    0,
    0,
    canvas.width,
    canvas.height,
  );
}

type CameraScanV1 = {
  native: NativeQrDetectorV1 | undefined;
  player: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  decoder: QrFrameDecoderV1;
  signal: AbortSignal;
  nextStep: () => number;
  assisted: () => boolean;
};

/** The codes in the current frame: the platform detector first, then one step of the rotation. */
async function frameCodesV1(scan: CameraScanV1): Promise<string[]> {
  const { native, player, canvas, context, decoder, signal } = scan;
  const codes = await nativeCodesV1(native, player);
  signal.throwIfAborted();
  if (codes.length) return codes;
  // Rotate: centre at full detail, centre sharpened (soft focus), whole frame.
  const step = scan.nextStep();
  drawCameraFrameV1(context, canvas, player, step, scan.assisted());
  const decoded = await decoder(context.getImageData(0, 0, canvas.width, canvas.height), signal, {
    sharpen: step === 1,
  });
  signal.throwIfAborted();
  return decoded;
}

/** A while without a read brings the distance tip (and, on the back camera, the zoom). */
function scheduleCameraAssistV1(signal: AbortSignal, assist: () => void) {
  const assistTimer = setTimeout(() => {
    if (signal.aborted) return;
    assist();
  }, CAMERA_ASSIST_DELAY_MS_V1);
  signal.addEventListener('abort', () => clearTimeout(assistTimer), {
    once: true,
  });
}

/** The pause between frames, cut short when the reading stops. */
function cameraFrameGapV1(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, CAMERA_FRAME_GAP_MS_V1);
    signal.addEventListener('abort', done, { once: true });
  });
}

const qrMessage = (error: unknown) => {
  if (error instanceof QrInputErrorV1)
    return {
      invalid: 'Este QR não é um acesso válido ao Portal.',
      absent: 'Nenhum QR encontrado. Escolha uma imagem mais nítida.',
      multiple: 'Há mais de um QR. Enquadre ou recorte somente o seu.',
      large: 'A imagem é muito grande. Use até 10 MB e 16 megapixels.',
      unsupported: 'Escolha uma imagem PNG, JPEG ou WebP válida.',
      unavailable: 'Não foi possível ler o QR. Tente outra imagem.',
    }[error.reason];
  if (error instanceof DOMException && error.name === 'NotAllowedError')
    return 'A câmera não foi autorizada. Você pode escolher uma imagem do QR.';
  if (error instanceof DOMException && error.name === 'NotFoundError')
    return 'Nenhuma câmera disponível. Escolha uma imagem do QR.';
  return 'Não foi possível usar a câmera. Tente novamente ou escolha uma imagem.';
};

type PlatformV1 = 'android' | 'iphone';
const platformOfV1 = (): PlatformV1 =>
  typeof navigator !== 'undefined' && /iPhone|iPad|iPod/u.test(navigator.userAgent)
    ? 'iphone'
    : 'android';

/** Miniature of the printed access card (same layout, colours and header), so the student
 * recognises the card in hand and knows which QR to scan. Decorative: hidden from assistive tech.
 */
function AccessCardV1() {
  return (
    <div className="pa-access-card" aria-hidden="true">
      <div className="pa-access-card-head">
        <img className="pa-access-card-crest" src={SCHOOL_LOGO_SRC_V1} alt="" />
        <span className="pa-access-card-school">
          {SCHOOL_CARD_NAME_LINES_V1[0]}
          <b>{SCHOOL_CARD_NAME_LINES_V1[1]}</b>
        </span>
        <span className="pa-access-card-title">
          {'Portal do Aluno'}
          <b>Cartão de acesso</b>
        </span>
      </div>
      <div className="pa-access-card-body">
        <span className="pa-access-card-photo" />
        <span className="pa-access-card-name">
          {'SEU NOME'}
          <i />
          <em>SUA TURMA</em>
        </span>
        <span className="pa-access-card-qr" />
      </div>
      <div className="pa-access-card-foot" />
    </div>
  );
}

/**
 * A denied camera cannot be asked for again by the page: only the browser's site settings can
 * lift it. Explain how for the student's phone and make the gallery the main way in meanwhile.
 */
function CameraBlockedV1({ onRetry }: Readonly<{ onRetry: () => void }>) {
  const [platform, setPlatform] = useState<PlatformV1>(platformOfV1);
  return (
    <div className="pa-camera-blocked" role="alert">
      <div className="pa-camera-blocked-head">
        <span className="pa-camera-blocked-icon" aria-hidden="true">
          <CameraOff size={20} />
        </span>
        <div>
          <h3 className="card__title">Você bloqueou a câmera</h3>
          <p className="card__description">
            Sem problema. Você pode entrar agora com uma foto do cartão ou liberar a câmera.
          </p>
        </div>
      </div>
      <p className="pa-camera-blocked-tip">
        <ImageIcon size={18} aria-hidden="true" />
        <span>
          <b>Mais rápido:</b> tire uma foto do QR do cartão com a câmera do celular e selecione a
          foto abaixo.
        </span>
      </p>
      <div className="pa-camera-blocked-how">
        <div className="pa-camera-blocked-how-top">
          <strong>Liberar a câmera</strong>
          <fieldset className="min-w-auto pa-camera-blocked-platforms" aria-label="Tipo de celular">
            {(['android', 'iphone'] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={platform === item}
                onClick={() => setPlatform(item)}
              >
                {item === 'android' ? 'Android' : 'iPhone'}
              </button>
            ))}
          </fieldset>
        </div>
        <ol className="pa-camera-blocked-steps">
          {platform === 'android' ? (
            <>
              <li>
                No topo da tela, toque no ícone{' '}
                <kbd aria-label="de ajustes">
                  <SlidersHorizontal size={13} aria-hidden="true" />
                </kbd>{' '}
                ao lado do endereço do site.
              </li>
              <li>
                Toque em <kbd>Permissões</kbd> e depois em <kbd>Câmera</kbd>.
              </li>
              <li>
                Escolha <kbd>Permitir</kbd> e volte aqui.
              </li>
            </>
          ) : (
            <>
              <li>
                Na barra de endereço, toque em <kbd>aA</kbd> (ou no ícone de ajustes).
              </li>
              <li>
                Toque em <kbd>Ajustes do Site</kbd> e depois em <kbd>Câmera</kbd>.
              </li>
              <li>
                Escolha <kbd>Permitir</kbd> e volte aqui.
              </li>
            </>
          )}
        </ol>
        <Button variant="secondary" className="pa-camera-blocked-retry" onPress={onRetry}>
          Tentar de novo com a câmera
        </Button>
      </div>
    </div>
  );
}

export function StudentQrReaderV1({
  onQr,
  decode,
}: Readonly<{
  onQr: (qr: string) => void;
  decode?: QrFrameDecoderV1;
}>) {
  const video = useRef<HTMLVideoElement>(null),
    input = useRef<HTMLInputElement>(null);
  const lease = useRef<ReturnType<typeof createCameraLeaseV1> | null>(null);
  const operation = useRef<AbortController | null>(null);
  const onRead = useRef(onQr);
  onRead.current = onQr;
  const [state, setState] = useState<'idle' | 'opening' | 'camera' | 'image'>('idle');
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [message, setMessage] = useState<string>();
  const [blocked, setBlocked] = useState(false);
  const [showDistanceTip, setShowDistanceTip] = useState(false);
  const stop = () => {
    operation.current?.abort();
    operation.current = null;
    lease.current?.stop();
    if (video.current) video.current.srcObject = null;
  };
  useEffect(() => {
    const leave = () => {
      stop();
      setState('idle');
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') {
        stop();
        setState('idle');
      }
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leave);
    // Where the browser already reports the camera as denied, show how to lift it up front
    // instead of letting the student tap a button that silently fails.
    // It also follows later changes: allowing the camera in the settings lifts the notice.
    let alive = true;
    let permission: PermissionStatus | undefined;
    const follow = () => {
      if (alive && permission) setBlocked(permission.state === 'denied');
    };
    void navigator.permissions
      ?.query({ name: 'camera' as PermissionName })
      .then((status) => {
        permission = status;
        follow();
        status.addEventListener?.('change', follow);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      permission?.removeEventListener?.('change', follow);
      stop();
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leave);
    };
  }, []);
  /** A student QR among the frame's codes ends the reading; any other code says why it is not. */
  const deliver = (codes: string[]) => {
    if (!codes.length) return false;
    try {
      const qr = selectStudentQrV1([...new Set(codes)]);
      stop();
      setState('idle');
      onRead.current(qr);
      return true;
    } catch (error) {
      setMessage(qrMessage(error));
      return false;
    }
  };
  /** A denied camera shows how to allow it; any other failure, its message. */
  const cameraFailed = (error: unknown) => {
    stop();
    setState('idle');
    if (error instanceof DOMException && error.name === 'NotAllowedError') setBlocked(true);
    else setMessage(qrMessage(error));
  };
  const camera = async (direction: 'environment' | 'user') => {
    stop();
    setMessage(undefined);
    setBlocked(false);
    setShowDistanceTip(false);
    setState('opening');
    setFacing(direction);
    const controller = new AbortController();
    operation.current = controller;
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new DOMException('Unavailable', 'NotFoundError');
      lease.current ??= createCameraLeaseV1(navigator.mediaDevices);
      const stream = await lease.current.open(direction);
      if (!stream || controller.signal.aborted) return;
      const player = video.current!;
      player.srcObject = stream;
      await player.play();
      controller.signal.throwIfAborted();
      setState('camera');
      let assisted = false;
      scheduleCameraAssistV1(controller.signal, () => {
        assisted = true;
        setShowDistanceTip(true);
        if (direction === 'environment') void lease.current?.zoomForDistance();
      });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new QrInputErrorV1('unavailable');
      const session = decode ? undefined : createQrCameraDecoderV1();
      const frameDecoder = decode ?? session!;
      if (session) controller.signal.addEventListener('abort', session.dispose, { once: true });
      const native = await nativeQrDetectorV1();
      controller.signal.throwIfAborted();
      let attempt = 0;
      const scan: CameraScanV1 = {
        native,
        player,
        canvas,
        context,
        decoder: frameDecoder,
        signal: controller.signal,
        nextStep: () => attempt++ % 3,
        assisted: () => assisted,
      };
      while (!controller.signal.aborted) {
        if (player.videoWidth && player.videoHeight && deliver(await frameCodesV1(scan))) return;
        await cameraFrameGapV1(controller.signal);
      }
    } catch (error) {
      if (!controller.signal.aborted) cameraFailed(error);
    }
  };
  const image = async (file: File) => {
    stop();
    setState('image');
    setMessage(undefined);
    const controller = new AbortController();
    operation.current = controller;
    try {
      const qr = await readQrImageV1(file, controller.signal, decode ?? decodeQrFrameV1);
      if (!controller.signal.aborted) {
        stop();
        setState('idle');
        onRead.current(qr);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        stop();
        setState('idle');
        setMessage(qrMessage(error));
      }
    }
  };
  let opening: ReactNode = null;
  if (blocked) {
    opening = <CameraBlockedV1 onRetry={() => void camera('environment')} />;
  } else if (state === 'idle') {
    opening = (
      <>
        <AccessCardV1 />
        <p className="card__description">
          Use o QR do seu cartão de acesso. É só apontar a câmera ou selecionar uma foto dele na
          galeria.
        </p>
      </>
    );
  }
  return (
    <div className="pa-qr-reader" data-blocked={blocked || undefined}>
      {opening}
      <video
        ref={video}
        muted
        playsInline
        aria-label="Câmera para ler o QR"
        className="pa-qr-video"
        hidden={state !== 'camera' && state !== 'opening'}
      />
      {state === 'camera' && showDistanceTip ? (
        <p className="card__description">
          <output className="contents">Se ficar borrado, afaste um pouco o cartão.</output>
        </p>
      ) : null}
      {message ? <p role="alert">{message}</p> : null}
      {state === 'opening' || state === 'image' ? (
        <p>
          <output className="contents">
            {state === 'image' ? 'Lendo imagem…' : 'Abrindo câmera…'}
          </output>
        </p>
      ) : null}
      <div className="pa-auth-actions">
        {state === 'idle' && !blocked ? (
          <Button
            size="lg"
            onPress={() => {
              void camera('environment');
            }}
          >
            Ler QR com câmera
          </Button>
        ) : null}
        {state === 'camera' ? (
          <Button
            variant="secondary"
            onPress={() => {
              void camera(facing === 'environment' ? 'user' : 'environment');
            }}
          >
            Trocar câmera
          </Button>
        ) : null}
        {state !== 'idle' ? (
          <Button
            variant="tertiary"
            onPress={() => {
              stop();
              setState('idle');
            }}
          >
            Cancelar leitura
          </Button>
        ) : null}
        <Button
          size="lg"
          variant={blocked ? 'primary' : 'secondary'}
          onPress={() => {
            stop();
            setState('idle');
            input.current?.click();
          }}
          isDisabled={state === 'image'}
        >
          Selecionar QR da galeria
        </Button>
        <input
          ref={input}
          className="pa-qr-file"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="Imagem do QR"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void image(file);
          }}
        />
      </div>
    </div>
  );
}

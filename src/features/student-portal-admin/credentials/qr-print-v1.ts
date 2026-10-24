// The print iframe inherits style-src 'self'; a small inlined data: asset would be blocked.
const stylesheet = new URL('./qr-print-v1.css?no-inline', import.meta.url).href;
/** DOM nodes only: neither operator labels nor credential strings are interpolated as HTML. */
export function createQrPrintV1() {
  const active = new Set<() => void>();
  return {
    print(imageUrl: string): Promise<boolean> {
      return new Promise((resolve) => {
        const frame = document.createElement('iframe');
        frame.className = 'pa-qr-print-host';
        frame.title = 'Impressão do QR';
        let settled = false;
        const finish = (ok = false) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          active.delete(cancel);
          frame.remove();
          resolve(ok);
        };
        const cancel = () => finish(false);
        const timer = setTimeout(cancel, 120_000);
        active.add(cancel);
        try {
          document.body.appendChild(frame);
          const doc = frame.contentDocument,
            target = frame.contentWindow;
          if (!doc || !target) {
            finish(false);
            return;
          }
          const style = doc.createElement('link');
          style.rel = 'stylesheet';
          style.href = stylesheet;
          const image = doc.createElement('img');
          image.className = 'qr-print-image';
          image.alt = 'QR de acesso';
          let styleReady = false,
            imageReady = false,
            printing = false;
          const ready = () => {
            if (!styleReady || !imageReady || printing || settled) return;
            printing = true;
            target.addEventListener('afterprint', () => finish(true), { once: true });
            try {
              target.focus();
              target.print();
            } catch {
              finish(false);
            }
          };
          style.onload = () => {
            styleReady = true;
            ready();
          };
          image.onload = () => {
            imageReady = true;
            ready();
          };
          style.onerror = image.onerror = () => finish(false);
          doc.head.appendChild(style);
          doc.body.appendChild(image);
          image.src = imageUrl;
        } catch {
          finish(false);
        }
      });
    },
    clear() {
      for (const cancel of active) cancel();
    },
  };
}

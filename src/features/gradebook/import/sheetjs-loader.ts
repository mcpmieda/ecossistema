import sheetJsUrl from 'xlsx/dist/xlsx.full.min.js?url';
import type { SheetJs } from './spreadsheet-recognizer';

// The same 0.20.3 file the CDN served, copied by Vite to /assets/ from the installed package.
const SHEETJS_INTEGRITY = 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT';

declare global {
  interface Window {
    XLSX?: SheetJs;
  }
}

let sheetJsPromise: Promise<SheetJs> | null = null;

export function loadSheetJs(): Promise<SheetJs> {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (sheetJsPromise) return sheetJsPromise;

  const pending = new Promise<SheetJs>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = sheetJsUrl;
    // The dev server appends an inline source map to the file; the build copies it byte for byte.
    if (import.meta.env.PROD) script.integrity = SHEETJS_INTEGRITY;
    script.crossOrigin = 'anonymous';
    script.async = true;
    script.addEventListener('load', () => {
      if (window.XLSX) resolve(window.XLSX);
      else reject(new Error('O leitor de planilhas não foi carregado.'));
    });
    script.addEventListener('error', () => {
      reject(new Error('Não foi possível carregar o leitor de planilhas.'));
    });
    document.head.appendChild(script);
  });

  sheetJsPromise = pending.catch((cause) => {
    sheetJsPromise = null;
    throw cause;
  });
  return sheetJsPromise;
}

export function preloadSheetJs(): void {
  void loadSheetJs().catch(() => undefined);
}

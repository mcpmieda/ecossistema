import type { QrArtifactV1 } from './qr-values-v1';

export async function pngDataUrlV1(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return 'data:' + blob.type + ';base64,' + btoa(binary);
}

/** Called by an explicit click, with a ready bitmap: no await before clipboard.write. */
export async function copyQrImageV1(
  artifact: QrArtifactV1,
): Promise<'copied' | 'download-required'> {
  if (artifact.format !== 'png' || artifact.blob.type !== 'image/png') return 'download-required';
  try {
    if (
      !globalThis.isSecureContext ||
      typeof ClipboardItem === 'undefined' ||
      !navigator.clipboard?.write ||
      (ClipboardItem.supports && !ClipboardItem.supports('image/png'))
    )
      return 'download-required';
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': artifact.blob })]);
    return 'copied';
  } catch {
    return 'download-required';
  }
}
export function createQrDownloadsV1() {
  const urls = new Map<string, ReturnType<typeof setTimeout>>();
  function revoke(url: string) {
    clearTimeout(urls.get(url));
    urls.delete(url);
    URL.revokeObjectURL(url);
  }
  return {
    download(artifact: QrArtifactV1, filename?: string) {
      const url = URL.createObjectURL(artifact.blob),
        anchor = document.createElement('a');
      urls.set(
        url,
        setTimeout(() => revoke(url), 30_000),
      );
      try {
        anchor.href = url;
        anchor.download =
          filename ?? (artifact.format === 'png' ? 'portal-qr.png' : 'portal-cartoes.pdf');
        document.body.appendChild(anchor);
        anchor.click();
      } catch (error) {
        revoke(url);
        throw error;
      } finally {
        anchor.remove();
      }
    },
    clear() {
      for (const url of urls.keys()) revoke(url);
    },
  };
}

import { trimEndCharsV1 } from '../../../../shared/trim-chars-v1';

export function qrFilenameV1(label: string | undefined, extension: 'pdf' | 'png') {
  const normalized = Array.from((label ?? '').normalize('NFC'), (character) => {
    const point = character.codePointAt(0)!;
    return point <= 31 || point === 127 ? ' ' : character;
  }).join('');
  const spaced = normalized
    .replace(/[\\/:*?"<>|]/gu, ' ')
    .replace(/[_\s]+/gu, ' ')
    .trim();
  const clean = trimEndCharsV1(spaced, '. ').slice(0, 100).trim();
  return (clean ? `QR DO ${clean}` : 'QR DE ACESSO').toLocaleUpperCase('pt-BR') + '.' + extension;
}

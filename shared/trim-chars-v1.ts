/**
 * Trimming a set of characters from the ends of a text by a linear scan, in place of regular
 * expressions such as `/=+$/` that backtrack on long inputs (Sonar S8786). Each character of
 * `chars` is one UTF-16 unit.
 */
export function trimEndCharsV1(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

export function trimStartCharsV1(value: string, chars: string): string {
  let start = 0;
  while (start < value.length && chars.includes(value[start]!)) start += 1;
  return value.slice(start);
}

export function trimCharsV1(value: string, chars: string): string {
  return trimStartCharsV1(trimEndCharsV1(value, chars), chars);
}

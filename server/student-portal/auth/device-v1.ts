import type { AuditDetailV1 } from '../../../shared/student-portal-contracts/admin-v1';

type DeviceV1 = NonNullable<AuditDetailV1['device']>;

/** The first family that matches wins; the order matters (an iPad may say "Macintosh"). */
const PLATFORMS: readonly (readonly [DeviceV1['platform'], (ua: string) => boolean])[] = [
  ['android', (ua) => /Android/iu.test(ua)],
  [
    'ios',
    (ua) => /iPhone|iPad|iPod/iu.test(ua) || (/Macintosh/iu.test(ua) && /Mobile\//iu.test(ua)),
  ],
  ['chromeos', (ua) => /CrOS/iu.test(ua)],
  ['windows', (ua) => /Windows/iu.test(ua)],
  ['macos', (ua) => /Macintosh|Mac OS X/iu.test(ua)],
  ['linux', (ua) => /Linux/iu.test(ua)],
];
/** Every browser name appears in others' user agents (Edge says "Chrome", Chrome says "Safari"). */
const BROWSERS: readonly (readonly [DeviceV1['browser'], RegExp])[] = [
  ['samsung', /SamsungBrowser/iu],
  ['edge', /Edg(?:e|A|iOS)?\//iu],
  ['firefox', /Firefox|FxiOS/iu],
  ['chrome', /Chrome|CriOS/iu],
  ['safari', /Safari/iu],
];

/**
 * Coarse device family of a sign-in (owner request 29/09/2026), enough to guide a family ("no
 * iPhone, pelo Safari") and never the user agent itself, a model or a version. Unknown reads as
 * "other"; no header at all keeps no device.
 */
export function deviceFamilyV1(userAgent: string | null | undefined): DeviceV1 | undefined {
  if (!userAgent) return undefined;
  const ua = userAgent.slice(0, 512);
  const platform = PLATFORMS.find(([, matches]) => matches(ua))?.[0] ?? 'other';
  const browser = BROWSERS.find(([, pattern]) => pattern.test(ua))?.[0] ?? 'other';
  return { platform, browser };
}

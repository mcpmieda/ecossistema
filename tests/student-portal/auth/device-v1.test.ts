import { describe, expect, it } from 'vitest';
import { deviceFamilyV1 } from '../../../server/student-portal/auth/device-v1';

describe('coarse device family for sign-in support (owner request 29/09/2026)', () => {
  it('keeps only platform and browser families', () => {
    expect(
      deviceFamilyV1(
        'Mozilla/5.0 (Linux; Android 14; SM-A146M) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36',
      ),
    ).toEqual({ platform: 'android', browser: 'samsung' });
    expect(
      deviceFamilyV1(
        'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36',
      ),
    ).toEqual({ platform: 'android', browser: 'chrome' });
    expect(
      deviceFamilyV1(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      ),
    ).toEqual({ platform: 'ios', browser: 'safari' });
    expect(
      deviceFamilyV1(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0 Mobile/15E148 Safari/604.1',
      ),
    ).toEqual({ platform: 'ios', browser: 'chrome' });
    expect(
      deviceFamilyV1(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Edg/128.0',
      ),
    ).toEqual({ platform: 'windows', browser: 'edge' });
    expect(
      deviceFamilyV1(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5; rv:130.0) Gecko/20100101 Firefox/130.0',
      ),
    ).toEqual({ platform: 'macos', browser: 'firefox' });
    expect(deviceFamilyV1('curl/8.0')).toEqual({ platform: 'other', browser: 'other' });
  });

  it('keeps no device without a user agent', () => {
    expect(deviceFamilyV1(null)).toBeUndefined();
    expect(deviceFamilyV1('')).toBeUndefined();
  });
});

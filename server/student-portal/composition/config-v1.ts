import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { PortalCryptoV1 } from '../crypto/crypto-v1';
import type { PortalLiveEnvV1 } from '../live/live-connect-v1';

export interface PortalCompositionEnvV1 extends PortalLiveEnvV1 {
  PORTAL_ENVIRONMENT: string;
  PORTAL_ORIGIN: string;
  PORTAL_ADMIN_TENANT_ID: string;
  PORTAL_SERVING_ENABLED?: string;
  PORTAL_PUBLICATION_MODE?: string;
  PORTAL_DB?: Pick<Hyperdrive, 'connectionString'>;
  PHOTO_STORAGE_SERVICE_KEY?: string;
  QR_HMAC_KEYS?: string;
  PASSWORD_PEPPER?: string;
  TURNSTILE_SECRET_KEY?: string;
  PORTAL_AUTH_GLOBAL?: Pick<RateLimit, 'limit'>;
  PORTAL_AUTH_SUBJECT?: Pick<RateLimit, 'limit'>;
  PORTAL_SESSION_ACCOUNT?: Pick<RateLimit, 'limit'>;
  PORTAL_READ_ACCOUNT?: Pick<RateLimit, 'limit'>;
  PORTAL_LIVE_ACCOUNT?: Pick<RateLimit, 'limit'>;
  PORTAL_PHOTO_ACCOUNT?: Pick<RateLimit, 'limit'>;
  PORTAL_STATUS_ACCOUNT?: Pick<RateLimit, 'limit'>;
  PORTAL_ADMIN_READ?: Pick<RateLimit, 'limit'>;
  PORTAL_ADMIN_IMPORT?: Pick<RateLimit, 'limit'>;
  PORTAL_ADMIN_WRITE?: Pick<RateLimit, 'limit'>;
  PORTAL_ADMIN_EXPORT?: Pick<RateLimit, 'limit'>;
  PORTAL_ADMIN_LIVE?: Pick<RateLimit, 'limit'>;
  PORTAL_ADMIN_REVOKE?: Pick<RateLimit, 'limit'>;

}

function keyring(value: string | undefined) {
  const parsed = z.record(z.string().regex(/^[1-9]\d{0,5}$/u),
    z.string().regex(/^[A-Za-z0-9+/]{43}=$/u)).parse(JSON.parse(value ?? '{}'));
  const ring = new Map(Object.entries(parsed).map(([version, encoded]) => {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== encoded) throw new Error('student-portal-key-invalid');
    return [Number(version), bytes] as const;
  }));
  if (!ring.size) throw new Error('student-portal-key-unavailable');
  return ring;
}

/** Existing versioned Portal keys only. Cursor key is a domain-separated child, never the ADM session key. */
export function portalKeysV1(env: PortalCompositionEnvV1) {
  const peppers = keyring(env.PASSWORD_PEPPER);
  const qrKeys = keyring(env.QR_HMAC_KEYS);
  const pepperVersion = Math.max(...peppers.keys());
  const qrKeyVersion = Math.max(...qrKeys.keys());
  return { cryptoPort: new PortalCryptoV1(peppers, qrKeys), pepperVersion, qrKeyVersion,
    cursorSecret: createHmac('sha256', qrKeys.get(qrKeyVersion)!).update('student-portal:admin-cursor:v1').digest('hex') };
}

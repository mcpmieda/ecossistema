import { z } from 'zod';
import type { RuntimeEnv } from '../env';
import { readCookie, secureCookie } from './cookies';
import { seal, unseal } from './sealed';

export const SESSION_POLICY_COOKIE = '__Host-ecossistema_session_policy';
export const SESSION_DURATION_OPTIONS_HOURS = [4, 8, 12] as const;
export const DEFAULT_SESSION_DURATION_HOURS = 8;

export type SessionDurationHours = (typeof SESSION_DURATION_OPTIONS_HOURS)[number];

const PREFERENCE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

const preferenceSchema = z
  .object({
    version: z.literal(1),
    oid: z.string().uuid(),
    durationHours: z.number().int(),
    exp: z.number().int().positive(),
  })
  .strict();

export function isSessionDurationHours(value: unknown): value is SessionDurationHours {
  return (
    typeof value === 'number' &&
    SESSION_DURATION_OPTIONS_HOURS.includes(value as SessionDurationHours)
  );
}

export async function readSessionDurationPreference(
  request: Request,
  env: RuntimeEnv,
  oid: string,
  now = Math.floor(Date.now() / 1000),
): Promise<SessionDurationHours> {
  const token = readCookie(request, SESSION_POLICY_COOKIE);
  if (!token) return DEFAULT_SESSION_DURATION_HOURS;

  const parsed = preferenceSchema.safeParse(
    await unseal<unknown>(token, env.SESSION_SECRET, 'session-policy'),
  );
  if (
    !parsed.success ||
    parsed.data.oid !== oid ||
    parsed.data.exp <= now ||
    !isSessionDurationHours(parsed.data.durationHours)
  ) {
    return DEFAULT_SESSION_DURATION_HOURS;
  }

  return parsed.data.durationHours;
}

export async function createSessionDurationPreferenceCookie(
  env: RuntimeEnv,
  oid: string,
  durationHours: SessionDurationHours,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const token = await seal(
    {
      version: 1,
      oid,
      durationHours,
      exp: now + PREFERENCE_MAX_AGE_SECONDS,
    },
    env.SESSION_SECRET,
    'session-policy',
  );

  return secureCookie(SESSION_POLICY_COOKIE, token, { maxAge: PREFERENCE_MAX_AGE_SECONDS });
}

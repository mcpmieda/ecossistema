import type { RuntimeEnv } from '../env';
import { z } from 'zod';

export type GraphCredentialSlot = 'A' | 'B';
export type TechnicalCredentialFailureStage = 'missing' | 'invalid';

export class TechnicalCredentialError extends Error {
  constructor(
    readonly purpose: 'GRAPH' | 'WEB',
    readonly stage: TechnicalCredentialFailureStage,
    readonly slots: readonly GraphCredentialSlot[],
  ) {
    super(`${purpose} technical credential is unavailable`);
  }
}

const rotatedCredentialSchema = z.object({
  privateKeyPkcs8: z.string().min(256),
  certificateThumbprint: z.string().min(20),
  keyId: z.string().uuid(),
  createdAt: z.string().datetime(),
});

export type GraphCredential = z.infer<typeof rotatedCredentialSchema> & {
  slot: GraphCredentialSlot;
};

type CredentialPurpose = 'GRAPH' | 'WEB';

function rotatedCredential(
  env: RuntimeEnv,
  purpose: CredentialPurpose,
  slot: 'A' | 'B',
): GraphCredential {
  const serialized = env[`${purpose}_CREDENTIAL_${slot}`];
  if (!serialized) throw new Error(`${purpose} credential slot ${slot} is missing`);
  return { ...rotatedCredentialSchema.parse(JSON.parse(serialized)), slot };
}

/** One named slot: it must be present and valid, with no fallback to the other. */
function requestedCredential(
  env: RuntimeEnv,
  purpose: CredentialPurpose,
  slot: GraphCredentialSlot,
): GraphCredential {
  try { return rotatedCredential(env, purpose, slot); }
  catch {
    throw new TechnicalCredentialError(
      purpose,
      env[`${purpose}_CREDENTIAL_${slot}`] ? 'invalid' : 'missing',
      [slot],
    );
  }
}

function technicalCredentials(
  env: RuntimeEnv,
  purpose: CredentialPurpose,
  requestedSlot?: GraphCredentialSlot,
): GraphCredential[] {
  if (requestedSlot) return [requestedCredential(env, purpose, requestedSlot)];

  const rotated: GraphCredential[] = [];
  const invalid: GraphCredentialSlot[] = [];
  for (const slot of ['A', 'B'] as const) {
    if (!env[`${purpose}_CREDENTIAL_${slot}`]) continue;
    try { rotated.push(rotatedCredential(env, purpose, slot)); }
    catch { invalid.push(slot); }
  }
  rotated.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (rotated.length === 0) {
    throw new TechnicalCredentialError(
      purpose,
      invalid.length ? 'invalid' : 'missing',
      invalid.length ? invalid : ['A', 'B'],
    );
  }
  return rotated;
}

export function graphCredentials(
  env: RuntimeEnv,
  requestedSlot?: GraphCredentialSlot,
): GraphCredential[] {
  return technicalCredentials(env, 'GRAPH', requestedSlot);
}

export function webCredentials(
  env: RuntimeEnv,
  requestedSlot?: GraphCredentialSlot,
): GraphCredential[] {
  return technicalCredentials(env, 'WEB', requestedSlot);
}

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type MaintenanceRotationTarget = 'web' | 'graph';
export type MaintenanceRotationSlot = 'A' | 'B';

const EXPECTED_TARGETS = {
  web: {
    appId: '78185e20-c824-4acc-9ccd-41b9f7509a6f',
    displayName: 'Ecossistema Escolar - Web',
  },
  graph: {
    appId: '7d565352-1f77-4a7c-a4a4-4ae1b55b5c0c',
    displayName: 'Ecossistema Escolar - Graph Backend',
  },
} as const;

type GraphFetcher = typeof fetch;

type KeyCredential = {
  keyId?: string;
  type?: string;
  usage?: string;
  key?: string | null;
  displayName?: string | null;
  startDateTime?: string | null;
  endDateTime?: string | null;
  customKeyIdentifier?: string | null;
};

type Application = {
  id?: string;
  appId?: string;
  displayName?: string;
  keyCredentials?: KeyCredential[];
  passwordCredentials?: unknown[];
};

export class MaintenanceRotationError extends Error {
  readonly stage: string;
  readonly status?: number;

  constructor(stage: string, status?: number) {
    super(status ? `Maintenance rotation failed at ${stage} (${status})` : `Maintenance rotation failed at ${stage}`);
    this.name = 'MaintenanceRotationError';
    this.stage = stage;
    this.status = status;
  }
}

type NormalizedKey = {
  keyId: string;
  type: 'AsymmetricX509Cert';
  usage: 'Verify';
  key: string;
  displayName: string;
  startDateTime: string;
  endDateTime: string;
  customKeyIdentifier?: string;
};

function requiredUuid(value: string, stage: string): string {
  const normalized = value.trim();
  if (!UUID.test(normalized)) throw new MaintenanceRotationError(stage);
  return normalized;
}

function requiredTarget(value: string): MaintenanceRotationTarget {
  if (value !== 'web' && value !== 'graph') throw new MaintenanceRotationError('invalid-target');
  return value;
}

function requiredSlot(value: string): MaintenanceRotationSlot {
  if (value !== 'A' && value !== 'B') throw new MaintenanceRotationError('invalid-slot');
  return value;
}

function opposite(slot: MaintenanceRotationSlot): MaintenanceRotationSlot {
  return slot === 'A' ? 'B' : 'A';
}

function timestamp(value: string, stage: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new MaintenanceRotationError(stage);
  return parsed;
}

function slotFromDisplayName(
  target: MaintenanceRotationTarget,
  displayName: string,
): MaintenanceRotationSlot {
  const match = new RegExp(`^automatic-${target}-slot-([AB])-`).exec(displayName);
  if (!match) throw new MaintenanceRotationError('unexpected-certificate-display-name');
  return requiredSlot(match[1] ?? '');
}

function normalizeExistingKey(
  target: MaintenanceRotationTarget,
  credential: KeyCredential,
): NormalizedKey & { slot: MaintenanceRotationSlot } {
  if (
    !credential.keyId ||
    !UUID.test(credential.keyId) ||
    credential.type !== 'AsymmetricX509Cert' ||
    credential.usage !== 'Verify' ||
    typeof credential.key !== 'string' ||
    credential.key.length === 0 ||
    typeof credential.displayName !== 'string' ||
    credential.displayName.length === 0 ||
    typeof credential.startDateTime !== 'string' ||
    typeof credential.endDateTime !== 'string'
  ) {
    throw new MaintenanceRotationError('certificate-preservation-data-incomplete');
  }
  timestamp(credential.startDateTime, 'certificate-start-invalid');
  timestamp(credential.endDateTime, 'certificate-end-invalid');
  const slot = slotFromDisplayName(target, credential.displayName);
  return {
    keyId: credential.keyId,
    type: 'AsymmetricX509Cert',
    usage: 'Verify',
    key: credential.key,
    displayName: credential.displayName,
    startDateTime: credential.startDateTime,
    endDateTime: credential.endDateTime,
    ...(typeof credential.customKeyIdentifier === 'string' && credential.customKeyIdentifier.length > 0
      ? { customKeyIdentifier: credential.customKeyIdentifier }
      : {}),
    slot,
  };
}

async function graphJson<T>(
  fetcher: GraphFetcher,
  token: string,
  path: string,
  stage: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(`${GRAPH_BASE}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MaintenanceRotationError(`${stage}-transport`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new MaintenanceRotationError(stage, response.status);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new MaintenanceRotationError(`${stage}-invalid-json`);
  }
}

async function readTarget(
  fetcher: GraphFetcher,
  token: string,
  target: MaintenanceRotationTarget,
  objectId: string,
): Promise<{ application: Application; keys: Array<NormalizedKey & { slot: MaintenanceRotationSlot }> }> {
  const select = 'id,appId,displayName,keyCredentials,passwordCredentials';
  const application = await graphJson<Application>(
    fetcher,
    token,
    `/applications/${encodeURIComponent(objectId)}?$select=${encodeURIComponent(select)}`,
    `${target}-application`,
  );
  const expected = EXPECTED_TARGETS[target];
  if (
    application.id !== objectId ||
    application.appId !== expected.appId ||
    application.displayName !== expected.displayName
  ) {
    throw new MaintenanceRotationError(`${target}-application-mismatch`);
  }
  if ((application.passwordCredentials ?? []).length !== 0) {
    throw new MaintenanceRotationError(`${target}-password-credential-present`);
  }
  const rawKeys = application.keyCredentials ?? [];
  if (rawKeys.length === 0) throw new MaintenanceRotationError(`${target}-certificate-missing`);
  const keys = rawKeys.map((key) => normalizeExistingKey(target, key));
  return { application, keys };
}

type PatchKey = {
  type: 'AsymmetricX509Cert';
  usage: 'Verify';
  key: string;
  displayName: string;
  startDateTime?: string;
  endDateTime?: string;
  customKeyIdentifier?: string;
};

function certificateIdentity(key: Pick<NormalizedKey, 'key' | 'displayName'>): string {
  return `${key.displayName}\u0000${key.key}`;
}

function preservedPatchKey(
  key: NormalizedKey & { slot?: MaintenanceRotationSlot },
): PatchKey {
  return {
    type: 'AsymmetricX509Cert',
    usage: 'Verify',
    key: key.key,
    displayName: key.displayName,
    ...(key.customKeyIdentifier ? { customKeyIdentifier: key.customKeyIdentifier } : {}),
  };
}

async function patchKeys(
  fetcher: GraphFetcher,
  token: string,
  objectId: string,
  keys: PatchKey[],
  stage: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(`${GRAPH_BASE}/applications/${encodeURIComponent(objectId)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ keyCredentials: keys }),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new MaintenanceRotationError(`${stage}-transport`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new MaintenanceRotationError(stage, response.status);
  }
  await response.body?.cancel().catch(() => undefined);
}

function activeSlotForTwo(
  keys: Array<NormalizedKey & { slot: MaintenanceRotationSlot }>,
): MaintenanceRotationSlot {
  if (keys.length !== 2) throw new MaintenanceRotationError('rotation-requires-two-certificates');
  const a = keys.filter((key) => key.slot === 'A');
  const b = keys.filter((key) => key.slot === 'B');
  if (a.length !== 1 || b.length !== 1) throw new MaintenanceRotationError('rotation-slot-layout-invalid');
  const aTime = timestamp(a[0]!.startDateTime, 'slot-a-start-invalid');
  const bTime = timestamp(b[0]!.startDateTime, 'slot-b-start-invalid');
  if (aTime === bTime) throw new MaintenanceRotationError('rotation-active-slot-ambiguous');
  return aTime > bTime ? 'A' : 'B';
}

export async function addRotationCertificate(input: {
  accessToken: string;
  target: MaintenanceRotationTarget;
  slot: MaintenanceRotationSlot;
  objectId: string;
  certificateDerBase64: string;
  displayName: string;
  startDateTime: string;
  endDateTime: string;
  fetcher?: GraphFetcher;
}): Promise<{
  status: 'added';
  target: MaintenanceRotationTarget;
  slot: MaintenanceRotationSlot;
  previousActiveSlot: MaintenanceRotationSlot;
  previousActiveKeyId: string;
  staleSameSlotKeyId: string;
  newGraphKeyId: string;
}> {
  const token = input.accessToken.trim();
  if (!token) throw new MaintenanceRotationError('missing-access-token');
  const objectId = requiredUuid(input.objectId, 'invalid-object-id');
  const startDateTime = new Date(timestamp(input.startDateTime, 'new-start-invalid')).toISOString();
  const endDateTime = new Date(timestamp(input.endDateTime, 'new-end-invalid')).toISOString();
  if (Date.parse(endDateTime) <= Date.parse(startDateTime)) {
    throw new MaintenanceRotationError('new-certificate-lifetime-invalid');
  }
  if (!input.certificateDerBase64 || !/^[A-Za-z0-9+/=]+$/u.test(input.certificateDerBase64)) {
    throw new MaintenanceRotationError('new-certificate-invalid');
  }
  const expectedPrefix = `automatic-${input.target}-slot-${input.slot}-`;
  if (!input.displayName.startsWith(expectedPrefix) || input.displayName.length > 90) {
    throw new MaintenanceRotationError('new-display-name-invalid');
  }

  const fetcher = input.fetcher ?? fetch;
  const { keys } = await readTarget(fetcher, token, input.target, objectId);
  const previousActiveSlot = activeSlotForTwo(keys);
  const expectedInactiveSlot = opposite(previousActiveSlot);
  if (input.slot !== expectedInactiveSlot) {
    throw new MaintenanceRotationError('requested-slot-is-not-inactive');
  }
  const previousActive = keys.find((key) => key.slot === previousActiveSlot)!;
  const staleSameSlot = keys.find((key) => key.slot === input.slot)!;
  const preserved = keys.map((key) => preservedPatchKey(key));
  const previousActiveIdentity = certificateIdentity(previousActive);
  const staleSameSlotIdentity = certificateIdentity(staleSameSlot);
  const newKey: PatchKey = {
    type: 'AsymmetricX509Cert',
    usage: 'Verify',
    key: input.certificateDerBase64,
    displayName: input.displayName,
    startDateTime,
    endDateTime,
  };
  await patchKeys(fetcher, token, objectId, [...preserved, newKey], 'add-certificate');

  let after = await readTarget(fetcher, token, input.target, objectId);
  let created = after.keys.find(
    (key) => key.displayName === input.displayName && key.key === input.certificateDerBase64,
  );
  for (let attempt = 0; !created && attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    after = await readTarget(fetcher, token, input.target, objectId);
    created = after.keys.find(
      (key) => key.displayName === input.displayName && key.key === input.certificateDerBase64,
    );
  }
  if (
    after.keys.length !== 3 ||
    !created ||
    !after.keys.some((key) => certificateIdentity(key) === previousActiveIdentity) ||
    !after.keys.some((key) => certificateIdentity(key) === staleSameSlotIdentity)
  ) {
    throw new MaintenanceRotationError('add-certificate-postcondition-failed');
  }

  return {
    status: 'added',
    target: input.target,
    slot: input.slot,
    previousActiveSlot,
    previousActiveKeyId: previousActive.keyId,
    staleSameSlotKeyId: staleSameSlot.keyId,
    newGraphKeyId: created.keyId,
  };
}

export async function removeExactCertificate(input: {
  accessToken: string;
  target: MaintenanceRotationTarget;
  objectId: string;
  keyId: string;
  fetcher?: GraphFetcher;
  pause?: (ms: number) => Promise<void>;
}): Promise<{ status: 'removed'; remainingCertificates: number }> {
  const token = input.accessToken.trim();
  if (!token) throw new MaintenanceRotationError('missing-access-token');
  const objectId = requiredUuid(input.objectId, 'invalid-object-id');
  const keyId = requiredUuid(input.keyId, 'invalid-key-id');
  const fetcher = input.fetcher ?? fetch;
  const { keys } = await readTarget(fetcher, token, input.target, objectId);
  if (!keys.some((key) => key.keyId === keyId)) throw new MaintenanceRotationError('key-to-remove-missing');
  if (keys.length <= 1) throw new MaintenanceRotationError('refuse-remove-last-certificate');
  const removed = keys.find((key) => key.keyId === keyId)!;
  const removedIdentity = certificateIdentity(removed);
  const remainingSource = keys.filter((key) => key.keyId !== keyId);
  const remaining = remainingSource.map((key) => preservedPatchKey(key));
  await patchKeys(fetcher, token, objectId, remaining, 'remove-certificate');
  const pause = input.pause ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let after = await readTarget(fetcher, token, input.target, objectId);
  for (let attempt = 0; attempt < 10; attempt++) {
    const converged =
      !after.keys.some((key) => certificateIdentity(key) === removedIdentity) &&
      after.keys.length === remaining.length &&
      remainingSource.every(
        (expected) => after.keys.some(
          (actual) => certificateIdentity(actual) === certificateIdentity(expected),
        ),
      );
    if (converged) {
      return { status: 'removed', remainingCertificates: after.keys.length };
    }
    if (attempt < 9) {
      await pause(1000);
      after = await readTarget(fetcher, token, input.target, objectId);
    }
  }
  throw new MaintenanceRotationError('remove-certificate-postcondition-failed');
}

export async function finalizeRotation(input: {
  accessToken: string;
  target: MaintenanceRotationTarget;
  slot: MaintenanceRotationSlot;
  objectId: string;
  fetcher?: GraphFetcher;
  pause?: (ms: number) => Promise<void>;
}): Promise<{
  status: 'finalized';
  target: MaintenanceRotationTarget;
  slot: MaintenanceRotationSlot;
  retainedNewKeyId: string;
  retainedRollbackSlot: MaintenanceRotationSlot;
  retainedRollbackKeyId: string;
  removedStaleKeyId: string;
}> {
  const token = input.accessToken.trim();
  if (!token) throw new MaintenanceRotationError('missing-access-token');
  const objectId = requiredUuid(input.objectId, 'invalid-object-id');
  const fetcher = input.fetcher ?? fetch;
  const { keys } = await readTarget(fetcher, token, input.target, objectId);
  if (keys.length !== 3) throw new MaintenanceRotationError('finalize-requires-three-certificates');
  const sameSlot = keys.filter((key) => key.slot === input.slot);
  const rollbackSlot = opposite(input.slot);
  const rollback = keys.filter((key) => key.slot === rollbackSlot);
  if (sameSlot.length !== 2 || rollback.length !== 1) {
    throw new MaintenanceRotationError('finalize-slot-layout-invalid');
  }
  const ordered = [...sameSlot].sort(
    (left, right) => timestamp(right.startDateTime, 'finalize-start-invalid') -
      timestamp(left.startDateTime, 'finalize-start-invalid'),
  );
  const newest = ordered[0]!;
  const stale = ordered[1]!;
  if (timestamp(newest.startDateTime, 'finalize-new-start-invalid') <=
      timestamp(rollback[0]!.startDateTime, 'finalize-rollback-start-invalid')) {
    throw new MaintenanceRotationError('finalize-new-certificate-not-preferred');
  }

  const newestIdentity = certificateIdentity(newest);
  const rollbackIdentity = certificateIdentity(rollback[0]!);
  const staleIdentity = certificateIdentity(stale);
  const remaining = keys
    .filter((key) => key.keyId !== stale.keyId)
    .map((key) => preservedPatchKey(key));
  await patchKeys(fetcher, token, objectId, remaining, 'finalize-certificate');
  const pause = input.pause ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let after = await readTarget(fetcher, token, input.target, objectId);
  for (let attempt = 0; attempt < 10; attempt++) {
    const retainedNew = after.keys.find((key) => certificateIdentity(key) === newestIdentity);
    const retainedRollback = after.keys.find((key) => certificateIdentity(key) === rollbackIdentity);
    const converged =
      after.keys.length === 2 &&
      retainedNew !== undefined &&
      retainedRollback !== undefined &&
      !after.keys.some((key) => certificateIdentity(key) === staleIdentity);
    if (converged) {
      return {
        status: 'finalized',
        target: input.target,
        slot: input.slot,
        retainedNewKeyId: retainedNew.keyId,
        retainedRollbackSlot: rollbackSlot,
        retainedRollbackKeyId: retainedRollback.keyId,
        removedStaleKeyId: stale.keyId,
      };
    }
    if (attempt < 9) {
      await pause(1000);
      after = await readTarget(fetcher, token, input.target, objectId);
    }
  }
  throw new MaintenanceRotationError('finalize-postcondition-failed');
}

async function main(): Promise<void> {
  const action = process.env.ROTATION_ACTION ?? '';
  const target = requiredTarget(process.env.ROTATION_TARGET ?? '');
  const objectId = process.env.APPLICATION_OBJECT_ID ?? '';
  const accessToken = process.env.GRAPH_ACCESS_TOKEN ?? '';

  if (action === 'add') {
    const slot = requiredSlot(process.env.ROTATION_SLOT ?? '');
    const certificatePath = process.env.CERT_DER_PATH ?? '';
    if (!certificatePath) throw new MaintenanceRotationError('missing-cert-der-path');
    const certificateDerBase64 = Buffer.from(readFileSync(certificatePath)).toString('base64');
    const result = await addRotationCertificate({
      accessToken,
      target,
      slot,
      objectId,
      certificateDerBase64,
      displayName: process.env.NEW_DISPLAY_NAME ?? '',
      startDateTime: process.env.NEW_START_DATE_TIME ?? '',
      endDateTime: process.env.NEW_END_DATE_TIME ?? '',
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (action === 'remove-exact') {
    const result = await removeExactCertificate({
      accessToken,
      target,
      objectId,
      keyId: process.env.KEY_ID_TO_REMOVE ?? '',
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (action === 'finalize') {
    const result = await finalizeRotation({
      accessToken,
      target,
      slot: requiredSlot(process.env.ROTATION_SLOT ?? ''),
      objectId,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  throw new MaintenanceRotationError('invalid-action');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error: unknown) {
    const safe =
      error instanceof MaintenanceRotationError
        ? error.message
        : 'Maintenance rotation failed unexpectedly';
    console.error(safe);
    process.exitCode = 1;
  }
}

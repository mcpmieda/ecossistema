import type { RuntimeEnv } from '../../../env';
import { GraphError, graphRequest, type GraphDependencies } from '../../../graph/client';
import { graphDefaultsV1 } from '../../../graph/request-policy-v1';
import type { GraphAppEnvV1 } from '../graph-drive-v1';

/** A workbook as the links refresh needs it: its version (eTag), content hash and folder path. */
export type LinkItemV1 = {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly lastModifiedDateTime: string;
  readonly eTag: string;
  readonly quickXorHash: string | null;
  /** Folder path inside the drive, without the drive prefix ("" for the root). */
  readonly folderPath: string | null;
};

type GraphLinkItemV1 = {
  id?: unknown;
  name?: unknown;
  size?: unknown;
  lastModifiedDateTime?: unknown;
  eTag?: unknown;
  file?: { hashes?: { quickXorHash?: unknown } };
  parentReference?: { path?: unknown };
};

const LINK_ITEM_FIELDS_V1 = 'id,name,size,lastModifiedDateTime,eTag,file,parentReference';

const asEnvV1 = (env: GraphAppEnvV1) => env as unknown as RuntimeEnv;

function linkItemV1(data: GraphLinkItemV1 | null): LinkItemV1 | null {
  if (
    !data ||
    typeof data.id !== 'string' ||
    typeof data.name !== 'string' ||
    typeof data.size !== 'number' ||
    typeof data.lastModifiedDateTime !== 'string' ||
    typeof data.eTag !== 'string' ||
    !data.file
  )
    return null;
  const hash = data.file.hashes?.quickXorHash;
  const parent = typeof data.parentReference?.path === 'string' ? data.parentReference.path : null;
  // "/drives/{id}/root:/A/B" → "A/B"; the root itself is "/drives/{id}/root:".
  const folderPath = parent === null ? null : decodeURIComponent(parent.replace(/^[^:]*:\/?/u, ''));
  return {
    id: data.id,
    name: data.name,
    size: data.size,
    lastModifiedDateTime: data.lastModifiedDateTime,
    eTag: data.eTag,
    quickXorHash: typeof hash === 'string' && hash ? hash : null,
    folderPath,
  };
}

async function itemOrNullV1(
  env: GraphAppEnvV1,
  path: string,
  dependencies: GraphDependencies,
): Promise<LinkItemV1 | null> {
  try {
    const { data } = await graphRequest<GraphLinkItemV1>({ env: asEnvV1(env), path, dependencies });
    return linkItemV1(data);
  } catch (cause) {
    if (cause instanceof GraphError && cause.status === 404) return null;
    throw cause;
  }
}

export function graphLinkItemV1(
  env: GraphAppEnvV1,
  driveId: string,
  itemId: string,
  dependencies: GraphDependencies = graphDefaultsV1,
): Promise<LinkItemV1 | null> {
  return itemOrNullV1(
    env,
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}?$select=${LINK_ITEM_FIELDS_V1}`,
    dependencies,
  );
}

/** A file by its path in the drive ("A/B/file.xlsb"), for links that only keep an address. */
export function graphLinkItemByPathV1(
  env: GraphAppEnvV1,
  driveId: string,
  path: string,
  dependencies: GraphDependencies = graphDefaultsV1,
): Promise<LinkItemV1 | null> {
  const encoded = path
    .split('/')
    .filter(Boolean)
    .map((piece) => encodeURIComponent(piece))
    .join('/');
  if (!encoded) return Promise.resolve(null);
  return itemOrNullV1(
    env,
    `/drives/${encodeURIComponent(driveId)}/root:/${encoded}?$select=${LINK_ITEM_FIELDS_V1}`,
    dependencies,
  );
}

/** The drive's web address (".../personal/<user>/Documents"), to recognise link addresses inside it. */
export async function graphDriveWebUrlV1(
  env: GraphAppEnvV1,
  driveId: string,
  dependencies: GraphDependencies = graphDefaultsV1,
): Promise<string> {
  const { data, correlationId } = await graphRequest<{ webUrl?: unknown }>({
    env: asEnvV1(env),
    path: `/drives/${encodeURIComponent(driveId)}?$select=webUrl`,
    dependencies,
  });
  if (typeof data?.webUrl !== 'string' || !data.webUrl) throw new GraphError(502, correlationId);
  return data.webUrl;
}

export type ReplaceOutcomeV1 =
  | {
      readonly outcome: 'written';
      readonly eTag: string | null;
      readonly quickXorHash: string | null;
      readonly lastModifiedDateTime: string | null;
    }
  /** Someone has the file open (Excel for the web or desktop): nothing was written. */
  | { readonly outcome: 'locked' }
  /** The file changed after the version the new content was built from: nothing was written. */
  | { readonly outcome: 'changed' };

const UPLOAD_TIMEOUT_MS_V1 = 60_000;

function uploadUrlV1(raw: unknown): URL {
  if (typeof raw !== 'string') throw new GraphError(502, crypto.randomUUID());
  const url = new URL(raw);
  // The session address is pre-authenticated and points at the SharePoint host of the drive.
  if (url.protocol !== 'https:' || !url.hostname.toLowerCase().endsWith('.sharepoint.com'))
    throw new GraphError(502, crypto.randomUUID());
  return url;
}

type ReplaceInputV1 = {
  readonly driveId: string;
  readonly itemId: string;
  readonly eTag: string;
  readonly bytes: Uint8Array;
};

/** 423: someone has it open; 409/412: it changed after the version read. Anything else: null. */
function refusedOutcomeV1(status: number): ReplaceOutcomeV1 | null {
  if (status === 423) return { outcome: 'locked' };
  if (status === 409 || status === 412) return { outcome: 'changed' };
  return null;
}

/** The upload session, created only while the file is still at `eTag` (if-match). */
async function createUploadSessionV1(
  env: GraphAppEnvV1,
  input: ReplaceInputV1,
  dependencies: GraphDependencies,
): Promise<URL | ReplaceOutcomeV1> {
  try {
    const { data } = await graphRequest<{ uploadUrl?: unknown }>({
      env: asEnvV1(env),
      method: 'POST',
      path: `/drives/${encodeURIComponent(input.driveId)}/items/${encodeURIComponent(input.itemId)}/createUploadSession`,
      body: { item: { '@microsoft.graph.conflictBehavior': 'replace' } },
      etag: input.eTag,
      dependencies,
    });
    return uploadUrlV1(data?.uploadUrl);
  } catch (cause) {
    const refused = cause instanceof GraphError ? refusedOutcomeV1(cause.status) : null;
    if (refused) return refused;
    throw cause;
  }
}

async function writtenOutcomeV1(response: Response): Promise<ReplaceOutcomeV1> {
  const item = (await response.json().catch(() => null)) as GraphLinkItemV1 | null;
  const hash = item?.file?.hashes?.quickXorHash;
  return {
    outcome: 'written',
    eTag: typeof item?.eTag === 'string' ? item.eTag : null,
    quickXorHash: typeof hash === 'string' && hash ? hash : null,
    lastModifiedDateTime:
      typeof item?.lastModifiedDateTime === 'string' ? item.lastModifiedDateTime : null,
  };
}

/**
 * Replaces the workbook's content only if it is still at `eTag` (documented `if-match` of the
 * upload session: 412 when someone saved meanwhile) and nobody holds it open (423). The lock is
 * never bypassed. A single fragment carries the whole file (the sync handles at most a few MB).
 */
export async function graphReplaceWorkbookV1(
  env: GraphAppEnvV1,
  input: ReplaceInputV1,
  dependencies: GraphDependencies = graphDefaultsV1,
): Promise<ReplaceOutcomeV1> {
  const session = await createUploadSessionV1(env, input, dependencies);
  if (!(session instanceof URL)) return session;
  const size = input.bytes.length;
  let response: Response;
  try {
    // No Authorization header: the session address carries its own (documented 401 otherwise).
    // The body has a known length, so the runtime sends Content-Length itself.
    response = await dependencies.fetch(session.href, {
      method: 'PUT',
      redirect: 'manual',
      headers: { 'Content-Range': `bytes 0-${size - 1}/${size}` },
      body: input.bytes as Uint8Array<ArrayBuffer>,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS_V1),
    });
  } catch {
    await cancelSessionV1(session, dependencies);
    // The content may or may not have been committed: the caller re-reads the item.
    throw new GraphError(503, crypto.randomUUID());
  }
  if (response.ok) return writtenOutcomeV1(response);
  await response.body?.cancel().catch(() => undefined);
  await cancelSessionV1(session, dependencies);
  const refused = refusedOutcomeV1(response.status);
  if (refused) return refused;
  throw new GraphError(response.status, crypto.randomUUID());
}

/**
 * Whether someone holds the file open, without writing anything: an upload session is opened (it
 * is refused with 423 while the file is locked) and dropped at once.
 */
export async function graphProbeLockV1(
  env: GraphAppEnvV1,
  input: { readonly driveId: string; readonly itemId: string; readonly eTag: string },
  dependencies: GraphDependencies = graphDefaultsV1,
): Promise<'locked' | 'free'> {
  const session = await createUploadSessionV1(
    env,
    { ...input, bytes: new Uint8Array(0) },
    dependencies,
  );
  if (session instanceof URL) {
    await cancelSessionV1(session, dependencies);
    return 'free';
  }
  return session.outcome === 'locked' ? 'locked' : 'free';
}

async function cancelSessionV1(url: URL, dependencies: GraphDependencies): Promise<void> {
  await dependencies
    .fetch(url.href, { method: 'DELETE', redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    .then((response) => response.body?.cancel())
    .catch(() => undefined);
}

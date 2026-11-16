import { PT_BR_COLLATOR_V1 } from '../../../shared/locale-format-v1';
import type { RuntimeEnv } from '../../env';
import { GraphError, forgetGraphTokensV1, getGraphToken, graphRequest, type GraphDependencies } from '../../graph/client';
import { graphDefaultsV1, graphFetchV1, graphUrlV1 } from '../../graph/request-policy-v1';

/** Only what the Graph app credential needs; the sync Worker carries nothing else of RuntimeEnv. */
export type GraphAppEnvV1 = {
  TENANT_ID: string;
  GRAPH_CLIENT_ID: string;
  GRAPH_CREDENTIAL_A?: string;
  GRAPH_CREDENTIAL_B?: string;
};

export type DriveWorkbookV1 = {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly lastModifiedDateTime: string;
  readonly eTag: string | null;
  readonly quickXorHash: string | null;
  readonly parentId: string | null;
  readonly deleted: boolean;
};

type GraphDriveItemV1 = {
  id?: unknown;
  name?: unknown;
  size?: unknown;
  lastModifiedDateTime?: unknown;
  eTag?: unknown;
  file?: { hashes?: { quickXorHash?: unknown } };
  folder?: unknown;
  deleted?: unknown;
  parentReference?: { id?: unknown };
};

const WORKBOOK_EXTENSION_V1 = /\.(xlsb|xlsx|xls)$/iu;
const ITEM_FIELDS_V1 = 'id,name,size,lastModifiedDateTime,eTag,file,folder,deleted,parentReference';

function asEnvV1(env: GraphAppEnvV1): RuntimeEnv {
  return env as unknown as RuntimeEnv;
}

/** A workbook file, or null for folders, other files and malformed items. Deletions keep only their id. */
export function driveWorkbookFromItemV1(item: GraphDriveItemV1): DriveWorkbookV1 | null {
  if (typeof item.id !== 'string' || !item.id) return null;
  const parentId = typeof item.parentReference?.id === 'string' ? item.parentReference.id : null;
  if (item.deleted) {
    return { id: item.id, name: '', size: 0, lastModifiedDateTime: '', eTag: null, quickXorHash: null, parentId, deleted: true };
  }
  if (item.folder || !item.file || typeof item.name !== 'string' || !WORKBOOK_EXTENSION_V1.test(item.name)) return null;
  if (typeof item.size !== 'number' || typeof item.lastModifiedDateTime !== 'string') return null;
  const hash = item.file.hashes?.quickXorHash;
  return {
    id: item.id,
    name: item.name,
    size: item.size,
    lastModifiedDateTime: item.lastModifiedDateTime,
    eTag: typeof item.eTag === 'string' ? item.eTag : null,
    quickXorHash: typeof hash === 'string' && hash ? hash : null,
    parentId,
    deleted: false,
  };
}

export async function graphDriveIdV1(env: GraphAppEnvV1, siteId: string, dependencies?: GraphDependencies): Promise<string> {
  const { data, correlationId } = await graphRequest<{ id?: unknown }>({
    env: asEnvV1(env), path: `/sites/${encodeURIComponent(siteId)}/drive?$select=id`, dependencies });
  if (typeof data?.id !== 'string' || !data.id) throw new GraphError(502, correlationId);
  return data.id;
}

export async function graphFolderWorkbooksV1(env: GraphAppEnvV1, driveId: string, folderId: string,
  dependencies: GraphDependencies = graphDefaultsV1): Promise<DriveWorkbookV1[]> {
  const token = await getGraphToken(asEnvV1(env), dependencies);
  const files: DriveWorkbookV1[] = [];
  let next: string | null =
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(folderId)}/children?$select=${ITEM_FIELDS_V1}&$top=200`;
  const seen = new Set<string>();
  while (next) {
    const url = graphUrlV1(next);
    if (seen.has(url) || seen.size >= 50) throw new Error('Graph folder pagination capacity exceeded');
    seen.add(url);
    const { data, correlationId } = await graphRequest<{ value?: GraphDriveItemV1[]; '@odata.nextLink'?: unknown }>({
      env: asEnvV1(env), path: url, token, dependencies });
    if (!Array.isArray(data?.value)) throw new GraphError(502, correlationId);
    for (const item of data.value) {
      const workbook = driveWorkbookFromItemV1(item);
      if (workbook && !workbook.deleted) files.push(workbook);
    }
    next = typeof data['@odata.nextLink'] === 'string' ? data['@odata.nextLink'] : null;
  }
  return files;
}

/** One workbook by its Graph id (a single-file source), or null when it is gone or not a workbook. */
export async function graphWorkbookItemV1(env: GraphAppEnvV1, driveId: string, itemId: string,
  dependencies: GraphDependencies = graphDefaultsV1): Promise<DriveWorkbookV1 | null> {
  try {
    const { data } = await graphRequest<GraphDriveItemV1>({ env: asEnvV1(env), dependencies,
      path: `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}?$select=${ITEM_FIELDS_V1}` });
    const workbook = data ? driveWorkbookFromItemV1(data) : null;
    return workbook && !workbook.deleted ? workbook : null;
  } catch (cause) {
    if (cause instanceof GraphError && cause.status === 404) return null;
    throw cause;
  }
}

/** A folder of a children listing, or null for files and malformed items. */
function childFolderV1(item: { id?: unknown; name?: unknown; folder?: { childCount?: unknown } }):
  { id: string; name: string; childFolders: number } | null {
  if (!item.folder || typeof item.id !== 'string' || typeof item.name !== 'string') return null;
  const childFolders = typeof item.folder.childCount === 'number' ? item.folder.childCount : 0;
  return { id: item.id, name: item.name, childFolders };
}

/**
 * The drive's current delta cursor without listing anything (Graph `token=latest`): the nightly
 * check and a new source list their own folders, and the next delta starts from here (issue #1426,
 * finding 1: asking for a cursor from scratch enumerated the whole OneDrive).
 */
export async function graphLatestDeltaLinkV1(env: GraphAppEnvV1, driveId: string,
  dependencies: GraphDependencies = graphDefaultsV1): Promise<string> {
  const { data, correlationId } = await graphRequest<{ '@odata.deltaLink'?: unknown }>({ env: asEnvV1(env), dependencies,
    path: `/drives/${encodeURIComponent(driveId)}/root/delta?token=latest&$select=${ITEM_FIELDS_V1}` });
  const link = data?.['@odata.deltaLink'];
  if (typeof link !== 'string' || !link) throw new GraphError(502, correlationId);
  return graphUrlV1(link);
}

/** Sub-folders of a folder (the drive root when `parentId` is null), for the admin folder picker. */
export async function graphChildFoldersV1(env: GraphAppEnvV1, driveId: string, parentId: string | null,
  dependencies: GraphDependencies = graphDefaultsV1): Promise<Array<{ id: string; name: string; childFolders: number }>> {
  const token = await getGraphToken(asEnvV1(env), dependencies);
  const parent = parentId === null ? 'root' : `items/${encodeURIComponent(parentId)}`;
  const folders: Array<{ id: string; name: string; childFolders: number }> = [];
  let next: string | null = `/drives/${encodeURIComponent(driveId)}/${parent}/children?$select=id,name,folder&$top=200`;
  const seen = new Set<string>();
  while (next) {
    const url = graphUrlV1(next);
    if (seen.has(url) || seen.size >= 20) throw new Error('Graph folder pagination capacity exceeded');
    seen.add(url);
    const { data, correlationId } = await graphRequest<{
      value?: Array<{ id?: unknown; name?: unknown; folder?: { childCount?: unknown } }>; '@odata.nextLink'?: unknown;
    }>({ env: asEnvV1(env), path: url, token, dependencies });
    if (!Array.isArray(data?.value)) throw new GraphError(502, correlationId);
    for (const item of data.value) {
      const folder = childFolderV1(item);
      if (folder) folders.push(folder);
    }
    next = typeof data['@odata.nextLink'] === 'string' ? data['@odata.nextLink'] : null;
  }
  return folders.sort((a, b) => PT_BR_COLLATOR_V1.compare(a.name, b.name));
}

/**
 * Changes since `deltaLink` (or the full current state when absent). OneDrive for Business only
 * offers delta on the drive root, so callers keep the items whose parent is their folder.
 */
export async function graphDriveDeltaV1(env: GraphAppEnvV1, driveId: string, deltaLink: string | null,
  dependencies: GraphDependencies = graphDefaultsV1): Promise<{ changes: DriveWorkbookV1[]; deltaLink: string }> {
  const token = await getGraphToken(asEnvV1(env), dependencies);
  const changes: DriveWorkbookV1[] = [];
  let next: string = deltaLink ?? `/drives/${encodeURIComponent(driveId)}/root/delta?$select=${ITEM_FIELDS_V1}`;
  const seen = new Set<string>();
  for (;;) {
    const url = graphUrlV1(next);
    // A cursor too old to page through is started over, like a 410 (issue #1450, 3).
    if (seen.has(url) || seen.size >= 500) throw new DeltaResyncRequiredError();
    seen.add(url);
    const { data, correlationId } = await graphRequest<{
      value?: GraphDriveItemV1[]; '@odata.nextLink'?: unknown; '@odata.deltaLink'?: unknown;
    }>({ env: asEnvV1(env), path: url, token, dependencies }).catch((cause: unknown) => {
      // Graph no longer knows the cursor (410 Gone, resyncRequired): it must be started over.
      if (cause instanceof GraphError && cause.status === 410) throw new DeltaResyncRequiredError();
      throw cause;
    });
    if (!Array.isArray(data?.value)) throw new GraphError(502, correlationId);
    for (const item of data.value) {
      const workbook = driveWorkbookFromItemV1(item);
      if (workbook) changes.push(workbook);
    }
    if (typeof data['@odata.nextLink'] === 'string') { next = data['@odata.nextLink']; continue; }
    if (typeof data['@odata.deltaLink'] === 'string') return { changes, deltaLink: graphUrlV1(data['@odata.deltaLink']) };
    throw new GraphError(502, correlationId);
  }
}

/** The delta cursor cannot be used any more: list the sources again from the current cursor. */
export class DeltaResyncRequiredError extends Error {
  constructor() {
    super('Graph delta cursor must be started over');
  }
}

export class WorkbookTooLargeError extends Error {
  constructor(readonly size: number) {
    super('Workbook exceeds the sync size limit');
  }
}

/** The file bytes; the Graph `/content` redirect goes to a pre-authenticated download URL. */
export async function graphDownloadWorkbookV1(env: GraphAppEnvV1, driveId: string, itemId: string,
  maxBytes: number, dependencies: GraphDependencies = graphDefaultsV1): Promise<ArrayBuffer> {
  const token = await getGraphToken(asEnvV1(env), dependencies);
  const correlationId = crypto.randomUUID();
  const response = await graphFetchV1({
    url: graphUrlV1(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`),
    init: { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'client-request-id': correlationId } },
    correlationId, dependencies, allowContentRedirect: true, budgetMs: 30_000,
  }).catch((cause: unknown) => {
    // A refused token is not reused by the next download (issue #1450, 12a).
    if (cause instanceof GraphError && cause.status === 401) forgetGraphTokensV1(asEnvV1(env));
    throw cause;
  });
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new WorkbookTooLargeError(declared);
  }
  return readBoundedV1(response, maxBytes);
}

/** The body, read up to `maxBytes`: without a Content-Length a huge file is refused, not held in memory. */
async function readBoundedV1(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new WorkbookTooLargeError(size);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/** The address Graph posts its change notices to (the public URL without trailing slashes). */
export function notificationUrlV1(publicUrl: string, path: string): string {
  let end = publicUrl.length;
  while (end > 0 && publicUrl[end - 1] === '/') end -= 1;
  return `${publicUrl.slice(0, end)}${path}`;
}

/** Microsoft caps driveItem subscriptions at 42,300 minutes (~29 days). */
export const DRIVE_SUBSCRIPTION_MAX_MINUTES_V1 = 42_300;

export async function graphCreateDriveSubscriptionV1(env: GraphAppEnvV1, input: {
  driveId: string; notificationUrl: string; clientState: string; expiresAt: Date; dependencies?: GraphDependencies;
}): Promise<{ id: string; expirationDateTime: string }> {
  const { data, correlationId } = await graphRequest<{ id?: unknown; expirationDateTime?: unknown }>({
    env: asEnvV1(env), path: '/subscriptions', method: 'POST', dependencies: input.dependencies,
    body: {
      changeType: 'updated',
      resource: `/drives/${input.driveId}/root`,
      notificationUrl: input.notificationUrl,
      clientState: input.clientState,
      expirationDateTime: input.expiresAt.toISOString(),
    },
  });
  if (typeof data?.id !== 'string' || typeof data.expirationDateTime !== 'string') throw new GraphError(502, correlationId);
  return { id: data.id, expirationDateTime: data.expirationDateTime };
}

/** Moves a subscription's expiry (issue #1426, 12d): no new handshake, never two at once. Null when it is gone. */
export async function graphRenewSubscriptionV1(env: GraphAppEnvV1, subscriptionId: string, expiresAt: Date,
  dependencies?: GraphDependencies): Promise<string | null> {
  try {
    const { data, correlationId } = await graphRequest<{ expirationDateTime?: unknown }>({
      env: asEnvV1(env), path: `/subscriptions/${encodeURIComponent(subscriptionId)}`, method: 'PATCH', dependencies,
      body: { expirationDateTime: expiresAt.toISOString() },
    });
    if (typeof data?.expirationDateTime !== 'string') throw new GraphError(502, correlationId);
    return data.expirationDateTime;
  } catch (cause) {
    if (cause instanceof GraphError && cause.status === 404) return null;
    throw cause;
  }
}

export async function graphDeleteSubscriptionV1(env: GraphAppEnvV1, subscriptionId: string,
  dependencies?: GraphDependencies): Promise<void> {
  await graphRequest<null>({ env: asEnvV1(env), path: `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    method: 'DELETE', dependencies });
}

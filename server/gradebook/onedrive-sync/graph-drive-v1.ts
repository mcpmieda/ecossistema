import type { RuntimeEnv } from '../../env';
import { GraphError, getGraphToken, graphRequest, type GraphDependencies } from '../../graph/client';
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
      if (!item.folder || typeof item.id !== 'string' || typeof item.name !== 'string') continue;
      folders.push({ id: item.id, name: item.name, childFolders: typeof item.folder.childCount === 'number' ? item.folder.childCount : 0 });
    }
    next = typeof data['@odata.nextLink'] === 'string' ? data['@odata.nextLink'] : null;
  }
  return folders.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
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
    if (seen.has(url) || seen.size >= 500) throw new Error('Graph delta pagination capacity exceeded');
    seen.add(url);
    const { data, correlationId } = await graphRequest<{
      value?: GraphDriveItemV1[]; '@odata.nextLink'?: unknown; '@odata.deltaLink'?: unknown;
    }>({ env: asEnvV1(env), path: url, token, dependencies });
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
  });
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new WorkbookTooLargeError(declared);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new WorkbookTooLargeError(bytes.byteLength);
  return bytes;
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

export async function graphDeleteSubscriptionV1(env: GraphAppEnvV1, subscriptionId: string,
  dependencies?: GraphDependencies): Promise<void> {
  await graphRequest<null>({ env: asEnvV1(env), path: `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    method: 'DELETE', dependencies });
}

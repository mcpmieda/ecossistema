const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const READ_PATHS = [
  /^\/servicePrincipals$/u,
  new RegExp(`^/applications/${GUID}$`, 'iu'),
  new RegExp(`^/servicePrincipals/${GUID}/(?:appRoleAssignments|ownedObjects)$`, 'iu'),
  new RegExp(String.raw`^/sites/eduieda\.sharepoint\.com%2C${GUID}%2C${GUID}(?:/lists)?$`, 'iu'),
];

/** Restrict operational reads before a bearer token can reach the network.
 * Only caller-built Graph paths are accepted; remote nextLink/webUrl values are not URLs to follow.
 */
export function graphReadUrlV1(path: string): string {
  const pathname = path.split('?', 1)[0]!;
  if (
    path.length > 8192 ||
    /\s|\\/u.test(path) ||
    !READ_PATHS.some((allowed) => allowed.test(pathname))
  ) {
    throw new Error('entra-graph-read-url-not-allowed');
  }
  const url = new URL(`${GRAPH_ORIGIN}/v1.0${path}`);
  if (
    url.origin !== GRAPH_ORIGIN ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    path.includes('#') ||
    url.pathname !== `/v1.0${pathname}`
  ) {
    throw new Error('entra-graph-read-url-not-allowed');
  }
  return url.href;
}

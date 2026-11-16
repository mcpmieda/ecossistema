# Cloudflare read-only operator

Status: v2 for #1027, built on the capability probe from #1016.

## Purpose

The operator lets the repository owner and their coding sessions inspect bounded Cloudflare production state through GitHub Actions without exposing credentials and without depending on a local terminal.

It never accepts arbitrary shell, URL, HTTP method, account ID, resource ID or Cloudflare payload from an issue.

## Triggers

On an issue created by the repository owner, the owner may add one of these exact comments:

```text
/cloudflare
/cloudflare portal
```

- `/cloudflare`: capability probe for the existing Cloudflare credentials.
- `/cloudflare portal`: sanitized operational diagnostic for the fixed Portal resources.

The workflow also supports manual `workflow_dispatch` with the fixed operations `capabilities` or `portal`.

The workflow checks out trusted `main`, uses `persist-credentials: false`, runs in the existing `production` GitHub environment and publishes only the sanitized result back to the owner-authored issue.

## Existing credentials only

The operator reuses, without changing:

- `CLOUDFLARE_DEPLOY_TOKEN`
- `CLOUDFLARE_HYPERDRIVE_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

No token is created, rotated or widened. Each secret is injected only into the step that needs it. Rendering and GitHub commenting receive no Cloudflare secret.

The first real probe after #1016 proved:

| Capability | Deploy token | Hyperdrive token |
| --- | --- | --- |
| Workers scripts | accessible | accessible |
| Pages projects | accessible | permission-required |
| Hyperdrive configs | permission-required | accessible |
| Zones | accessible | accessible |
| Workers analytics | accessible | inconclusive |

Together, the two existing tokens cover every read-only surface needed by the current operator. No new Cloudflare credential is required for v2.

## Capability probe

Both existing tokens are tested against a fixed allowlist:

| Capability | Cloudflare API |
| --- | --- |
| Workers scripts | `GET /accounts/{account}/workers/scripts` |
| Pages projects | `GET /accounts/{account}/pages/projects` |
| Hyperdrive configs | `GET /accounts/{account}/hyperdrive/configs` |
| Zones | `GET /zones` filtered to the account |
| Workers analytics | GraphQL `workersInvocationsAdaptive` query |

The GraphQL call is a query, never a mutation. No raw analytics values are published by the capability probe.

DNS for the school remains authoritative at GoDaddy. Zone visibility is informational only and does not imply changing nameservers or DNS authority.

## Portal diagnostic

`/cloudflare portal` reads only the fixed production resources already named by the repository:

| Resource | Read | Published evidence |
| --- | --- | --- |
| Worker `student-portal-production` | Workers scripts list | presence, modified time and compatibility date |
| Pages `student-portal-edge` | exact Pages project | presence, production branch, canonical deployment status and creation time |
| Hyperdrive `PORTAL_DB` | exact config `46ac2fcb25ad4ad5b5662d536ccd968a` | presence, whether cache is disabled, origin connection limit |
| Worker analytics | GraphQL for `student-portal-production`, last 60 minutes | aggregate requests/errors plus maximum observed bucket CPU p50/p99 only |

The diagnostic never downloads Worker source and never publishes Pages environment variables, deployment aliases/domains, Hyperdrive origin/database/user/host/password, individual analytics events, student data or provider error payloads.

## Sanitized states

- `accessible`: the existing credential proved that surface.
- `permission-required`: REST returned HTTP 401/403.
- `not-found`: the fixed expected resource returned HTTP 404.
- `inconclusive`: the provider responded but did not prove the expected structure.
- `unavailable`: transport, rate limit or provider availability prevented proof.
- `credential-missing`: the named existing secret was not available to the workflow.

A non-accessible state does not authorize creating or expanding a token.

## Security boundary

The operator performs no mutable Cloudflare request.

- Resource reads are `GET`.
- `POST` is limited to GraphQL analytics and the fixed read-only Workers Observability queries described below.
- GraphQL documents contain no `mutation`.
- Issue input chooses only a fixed operation; it cannot inject URLs, resource IDs, methods or provider payloads.
- Raw provider responses are processed in memory and never copied to issue comments or artifacts.
- Cloudflare secrets are never passed to the renderer/comment step.

A future write operator is not implied by this read-only design. Mutations, wider permissions or additional credentials require a separate reviewed delivery and the applicable authorization.

### Implementation files

- Workflow: `.github/workflows/cloudflare-on-demand.yml`
- Executor: `scripts/cloudflare-operator-v1.ts`
- Tests: `tests/cloudflare-operator-v1.test.ts`
- Credential inventory: `docs/infra/AUTOMATION_CREDENTIAL_INVENTORY.md`


### CPU interpretation

The Portal diagnostic requests Cloudflare's documented `workersInvocationsAdaptive.quantiles.cpuTimeP50/cpuTimeP99` fields. Because the adaptive dataset can return multiple buckets in the 60-minute window, the published values are the **maximum bucket p50/p99 observed**, not a recomputed percentile for all requests. They are operational evidence only and are never correlated with user identity or request payload.

## Rate-limit preflight for #1249

The existing manual `/cloudflare portal` diagnostic also inventories rate-limit
bindings using only `CLOUDFLARE_DEPLOY_TOKEN`. This does not add a scheduled probe,
credential, permission, service, or mutable Cloudflare request. The owner/main
guards and existing sanitized issue response remain unchanged.

Fixed GET-only path families, under the existing configured account:

- `/workers/scripts`: the official SinglePage inventory (no caller-controlled filter);
- `/workers/scripts/{listed-script}/settings`: latest configured bindings;
- `/workers/scripts/{listed-script}/deployments`: current deployment at index zero;
- `/workers/scripts/{listed-script}/versions/{active-version-id}`: bindings of every
  version in that deployment, including 0% versions accessible by version override.

Script names and version IDs come only from validated provider metadata. The probe
never fetches Worker source, secrets endpoints, invocation logs, or arbitrary URLs.
It discards all bindings except `ratelimit`, and does not publish the names of other
Workers. Output is limited to counts/states, the candidate namespace range
3101249–3101259, and Portal binding names, namespace IDs, numeric quotas, and active
version IDs/percentages. Provider bodies, error messages and other binding values
are never written to logs, files or comments.

The probe is bounded to 100 scripts, 2 active versions per script, 2 MiB per response,
15 seconds per request and 120 seconds overall. These are diagnostic safety budgets,
not application capacity limits. Any missing credential, denied read, malformed
metadata, incomplete inventory or exceeded budget yields an explicit gap with
`complete=false`; namespace absence is never inferred from partial results.
A complete diagnostic still requires review of every namespace, expected Portal
tuple, and deployed version before approving release. `portal-only` means that the
ID appears only on the Portal, not that its name/quota matches the release.

Coverage is the uploaded Worker-script inventory, including normal Wrangler
`<name>-<env>` Workers, and all versions in current deployments. It is not a universal
account reservation registry: Workers for Platforms/dispatch namespaces and external
reservations are outside this bounded diagnostic; no such consumer is configured in
this repository. If another such consumer is known, stop and reconcile it before
publication. The observation does not lock the account against concurrent changes.

Preflight for #1249 expects all eleven new namespaces unused, or a previously applied
Portal tuple identical to the approved configuration. Any foreign reference or
multiple Portal binding names for one ID is a collision and blocks deployment.
Postflight additionally requires all eleven approved tuples in every active Portal
version and unchanged existing AUTH bindings. No traffic is generated to exhaust
quotas and no student account is used.

References: [Rate limiting namespaces](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
[Worker scripts](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/),
[deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/),
[versions](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/).

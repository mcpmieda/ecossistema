# Automation and credential inventory

Status: final baseline for #882, after Cloudflare segmentation, Entra OIDC Operations/Maintenance and Sonar Automatic Analysis.

This file records names, consumers and authority boundaries only. It must never contain secret values, private keys or access tokens.

## GitHub Actions secrets to keep

| Name | Consumer | Purpose / authority |
| --- | --- | --- |
| `CLOUDFLARE_DEPLOY_TOKEN` | `.github/workflows/deploy-cloudflare-pages.yml`, `.github/workflows/deploy-student-portal.yml`, `.github/workflows/entra-maintenance.yml`, `.github/workflows/cloudflare-on-demand.yml` | Pages/Workers deployment, bounded Maintenance update of one inactive runtime credential slot, and read-only capability probing without mutation. |
| `CLOUDFLARE_HYPERDRIVE_TOKEN` | `.github/workflows/deploy-cloudflare-pages.yml`, `.github/workflows/cloudflare-on-demand.yml` | Hyperdrive production verification/configuration and read-only capability probing without mutation. |

## Repository variables to keep

| Name | Consumer | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare deploy, Maintenance and read-only operator workflows | Cloudflare account selector; non-secret. |
| `ENTRA_TENANT_ID` | Entra Operations and Maintenance | Tenant selector; non-secret. |
| `ENTRA_OPERATIONS_CLIENT_ID` | `.github/workflows/entra-operations-audit.yml` | OIDC Operations identity. |
| `ENTRA_MAINTENANCE_CLIENT_ID` | `.github/workflows/entra-maintenance.yml` | OIDC Maintenance identity. |
| `WEB_APPLICATION_OBJECT_ID` | Entra Operations and Maintenance | Exact Web Application object target. |
| `GRAPH_APPLICATION_OBJECT_ID` | Entra Operations and Maintenance | Exact Graph Backend Application object target. |
| `ENTRA_SHAREPOINT_AUDIT_ENABLED` | Entra Operations | Enables selected-site read + negative isolation proof. |

## Items retired or approved for removal

| Name | Decision | Evidence |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` repository secret | retired | No workflow reads `secrets.CLOUDFLARE_API_TOKEN`; current workflows map the segmented tokens into the tool-local `CLOUDFLARE_API_TOKEN` environment variable. |
| `CLOUDFLARE_D1_API_TOKEN` | retired | No current repository consumer. |
| `GRADEBOOK_D1_BINDING_CONFIG` | retired | No productive consumer; tests explicitly require its absence from the deploy workflow. |
| `SONAR_HOST_URL` | remove | No repository consumer; Sonar Automatic Analysis is provided by the GitHub App. |
| `SONAR_ORGANIZATION` | remove | No repository consumer; Sonar Automatic Analysis is provided by the GitHub App. |
| `SONAR_PROJECT_KEY` | remove | No repository consumer; Sonar Automatic Analysis is provided by the GitHub App. |
| `JULES_API_KEY` | remove | No current code/workflow or open automation references it. API-first Factory pilots are closed historical runs; Jules remains an approved GitHub-connected executor. |
| `WEB_PRIVATE_KEY_PKCS8` / `WEB_CERT_THUMBPRINT` | retired | Runtime now accepts only Web A/B credential envelopes. |
| `GRAPH_PRIVATE_KEY_PKCS8` / `GRAPH_CERT_THUMBPRINT` | retired | Runtime now accepts only Graph A/B credential envelopes. |

## Runtime credentials outside GitHub Actions

Cloudflare Pages production keeps the private A/B credential envelopes:

- `WEB_CREDENTIAL_A`
- `WEB_CREDENTIAL_B`
- `GRAPH_CREDENTIAL_A`
- `GRAPH_CREDENTIAL_B`

The Worker `notas-onedrive-sync` (leitura das planilhas de notas no OneDrive) uses the same Graph application and keeps its own copy of `GRAPH_CREDENTIAL_A` / `GRAPH_CREDENTIAL_B`. `entra-maintenance.yml` writes the rotated Graph slot to Pages and then to this Worker; the Worker itself is published only by `deploy-cloudflare-pages.yml`. Its other secrets, `NOTAS_SYNC_CLIENT_STATE` and `NOTAS_SYNC_PROBE_TOKEN`, are random values set once on the Worker.

The matching public certificates are stored on the two Entra Application objects. Runtime selection prefers the newest valid `createdAt` value and can fall back only to the opposite A/B slot. There is no legacy single-certificate fallback.

## Authority matrix

### Cloudflare

- Deployment authority: `CLOUDFLARE_DEPLOY_TOKEN`.
- Hyperdrive authority: `CLOUDFLARE_HYPERDRIVE_TOKEN`.
- Production deploy remains gated by the official GitHub workflow and exact validated inputs.
- Read-only diagnostics may reuse both existing tokens through `.github/workflows/cloudflare-on-demand.yml`; this operator has a fixed API/query allowlist, never mutates Cloudflare and never widens token authority.
- A 401/403 from the operator is recorded as `permission-required`; it does not authorize creating or expanding a credential.
- Proof: deploy runs `35448332710`, `35449745901`, `35450722614`, `35451437586`, `35452195041`.

### Entra Operations

- Authentication: GitHub OIDC; no client secret.
- Microsoft Graph application permission: `Application.Read.All`.
- SharePoint: `Sites.Selected` with Read only on the productive site; isolation probe must remain denied.
- Read-only proof: run `35445150123`; later Operations audits remained green, including `35449745807`, `35450722643`, `35452195043`.

### Entra Maintenance

- Authentication: GitHub OIDC in environment `maintenance`; no client secret.
- Microsoft Graph application permission: only `Application.ReadWrite.OwnedBy`.
- Ownership scope: only the official Web and Graph Backend Application objects.
- Web A rotation: Maintenance `35452436869`, deploy `35452473324`, finalize `35452614518`.
- Graph B rotation: Maintenance `35452726038`, deploy `35452761978`, finalize `35452975216`.
- Recovery proof: orphan repair `35452309279`.

### SonarQube Cloud

- Analysis method: Automatic Analysis via GitHub App.
- No `SONAR_TOKEN`, scanner workflow or `sonar-project.properties`.
- `.sonarcloud.properties` defines only non-secret analysis metadata: project version, operational source scope and the dedicated `tests/` scope.
- The inherited New Code strategy is `previous_version`; `sonar.projectVersion=1.0.0` is kept stable between releases so the baseline is meaningful instead of treating almost the whole repository as new code.
- Historical learning archives/documentation are outside the executable source scope; operational code, workflows, migrations and tests remain analyzed.
- Sonar is intentionally informative/non-blocking unless branch protection is changed separately.

### Agents

- Jules: approved external/GitHub-connected executor; no repository API key is required by the current repository.
- CodeRabbit: optional independent reviewer; not an architectural or merge authority.
- GitHub Actions `github.token` is ephemeral workflow authority and is not a stored repository secret.

## Intentional limits

- Operations cannot write Entra applications.
- Maintenance cannot grant permissions, change app-role assignments or manage arbitrary applications.
- Sonar cannot deploy or merge.
- Auxiliary agents do not receive production secrets directly.
- The Cloudflare read-only operator receives existing Cloudflare secrets only inside bounded GitHub Actions steps; issue comments contain only sanitized capability states.
- A/B runtime credentials remain private in Cloudflare; issues, logs, artifacts and documentation contain no private key material.

## Manual GitHub cleanup after this file lands

Repository Settings → Secrets and variables → Actions:

1. Variables: delete `SONAR_HOST_URL`, `SONAR_ORGANIZATION`, `SONAR_PROJECT_KEY` if still present.
2. Secrets: delete `JULES_API_KEY` if still present.
3. Do not remove any item listed in “GitHub Actions secrets to keep” or “Repository variables to keep”.

After those four entries are absent, #910 can be closed and the final #911 validation can be completed.

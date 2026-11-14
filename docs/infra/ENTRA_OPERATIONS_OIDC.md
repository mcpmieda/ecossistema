# Entra Operations via GitHub OIDC

## Objetivo

Preparar uma identidade **read-only** para GitHub Actions auditar os dois App Registrations usados pelo Ecossistema sem armazenar client secret no GitHub.

O auditor é `scripts/entra/operations-audit.ts`. Ele não cria nem altera recursos Microsoft.

## Entradas futuras do workflow

- `ENTRA_TENANT_ID`
- `ENTRA_OPERATIONS_CLIENT_ID`
- `WEB_APPLICATION_OBJECT_ID`
- `GRAPH_APPLICATION_OBJECT_ID`
- `GRAPH_ACCESS_TOKEN` temporário obtido pelo workflow via GitHub OIDC

O access token nunca é incluído na saída.

## O que o auditor lê

Somente os dois applications identificados pelos object IDs informados e os respectivos service principals encontrados pelo `appId`.

A saída sanitizada contém:

- object ID, app/client ID e display name;
- `signInAudience`;
- redirect URIs Web/SPA/Public Client;
- metadados de certificados (sem material de chave privada);
- metadados de password credentials (sem secretText/hint);
- `requiredResourceAccess`;
- estado básico do service principal.

Erros Graph retornam apenas estágio + status HTTP, sem corpo bruto do provider.

## Drift read-only

A auditoria também compara o estado real com o baseline produtivo versionado para os dois apps:

- client/app ID esperado;
- `signInAudience`;
- redirect URIs autorizadas;
- existência e estado do service principal;
- presença de certificado técnico;
- certificado expirado ou próximo da expiração;
- presença de password credential;
- app-role assignments efetivamente concedidos ao service principal.

Drift de identidade, audience, redirect URI, service principal ausente/desabilitado ou certificado ausente/expirado é **crítico** e faz o workflow falhar fechado. Password credentials, certificados próximos da expiração e permissões amplas conhecidas são reportados como **warning** enquanto a migração de menor privilégio estiver em andamento.

O Job Summary publica somente status e contagens; os app-role assignments detalhados permanecem apenas no arquivo temporário do runner e são apagados ao final.

A identidade **Operations também audita a si própria**. O conjunto permitido de application permissions fica limitado a:
- `Application.Read.All`;
- `Sites.Selected`, quando/antes da habilitação da prova SharePoint.

Qualquer application permission adicional no service principal Operations é tratada como drift crítico. Assim, adicionar por engano `Directory.Read.All`, `Sites.Read.All`, `Sites.ReadWrite.All` ou outra permissão não aprovada faz a auditoria falhar fechado.

## Próxima etapa manual

Depois que o workflow OIDC for criado:

1. no App Registration correspondente a `ENTRA_OPERATIONS_CLIENT_ID`, adicionar a Federated Credential do repositório GitHub indicada pelo workflow;
2. conceder somente as permissões Microsoft Graph de leitura que o workflow documentar;
3. não criar client secret.

A identidade de Maintenance será tratada separadamente depois que Operations estiver comprovado.

## Workflow GitHub Actions

O workflow `.github/workflows/entra-operations-audit.yml` usa OIDC e não armazena client secret.

Execução real:
- `workflow_dispatch` na `main`;
- automaticamente após pushes na `main` que alterem o auditor/workflow/documentação relacionada;
- diariamente às 10:15 UTC para detectar drift externo mesmo sem mudança no repositório;
- sempre somente sobre a `main`;
- `id-token: write` existe apenas no job de auditoria;
- não depende de `azure/login` ou Azure CLI: o workflow solicita diretamente uma assertion OIDC ao GitHub e a troca no endpoint OAuth 2.0 do Entra;
- audience da assertion: `api://AzureADTokenExchange`;
- escopo do token final: `https://graph.microsoft.com/.default`;
- as assertions e o token Graph são temporários, mascarados e removidos do workspace após o auditor.

### Credencial federada a criar no Entra

Este repositório foi criado depois de 15/07/2026 e usa o formato OIDC imutável do GitHub.

- **Issuer:** `https://token.actions.githubusercontent.com`
- **Audience:** `api://AzureADTokenExchange`
- **Subject:** `repo:mcpmieda@268288370/ecossistema@1345061518:ref:refs/heads/main`

O subject inclui o **nome** do repositório. Depois que o repositório foi renomeado de `ecossistema-escola` para `ecossistema`, a troca OIDC passou a falhar (401) até a credencial federada ser atualizada com o nome novo (os IDs não mudam).

Criar essa Federated Credential no App Registration cujo Client ID está em `ENTRA_OPERATIONS_CLIENT_ID`.

### Permissão Microsoft Graph

Conceder somente a permissão **Application**:

- `Application.Read.All` — ID `9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30`

Essa permissão permite ler applications e service principals e requer admin consent. Não conceder `Directory.Read.All` nem permissões de escrita para esta identidade Operations.

Depois da federação e do consentimento, executar manualmente o workflow **Entra Operations audit**. Como o repositório é público, o JSON detalhado fica somente no runner e é apagado ao final; o GitHub recebe apenas um resumo mínimo no Job Summary.


## SharePoint com Sites.Selected

A auditoria de SharePoint está **habilitada em produção** após a concessão explícita do site. A identidade Operations permanece sem `Sites.Read.All` ou `Sites.FullControl.All`.

Identidade Operations atual:
- Client ID: `8d0378b4-832c-4703-8449-5ff2072589a5`
- permissão adicional prevista: `Sites.Selected` (Application), ID `883ea226-0bf2-4a8f-9f9d-92c9162a727d`.

Site produtivo selecionado:
- `eduieda.sharepoint.com,d8cb46fa-e401-40a9-9f81-876d59e8cbb0,89a47a04-34fa-4877-8a3c-00d35d246c56`

Estado de habilitação em 2026-09-19:
1. `Sites.Selected` adicionado como **Application permission** no App Registration Operations, com admin consent;
2. grant **Read** concedido somente ao site produtivo acima por contexto administrativo separado;
3. Repository Variable `ENTRA_SHAREPOINT_AUDIT_ENABLED=true` habilitada;
4. o workflow deve comprovar leitura do site selecionado e negação do site de isolamento.

Exemplo do grant administrativo pelo Microsoft Graph:

```http
POST https://graph.microsoft.com/v1.0/sites/eduieda.sharepoint.com,d8cb46fa-e401-40a9-9f81-876d59e8cbb0,89a47a04-34fa-4877-8a3c-00d35d246c56/permissions
Content-Type: application/json

{
  "roles": ["read"],
  "grantedToIdentities": [
    {
      "application": {
        "id": "8d0378b4-832c-4703-8449-5ff2072589a5",
        "displayName": "Ecossistema Operations - GitHub OIDC"
      }
    }
  ]
}
```

A chamada acima deve ser feita por uma identidade administrativa separada com autoridade para administrar permissões do site. Não guardar essa autoridade no workflow Operations.

Quando habilitada, a auditoria:
- lê o site selecionado e uma amostra limitada das listas;
- faz uma prova negativa contra o site raiz de comunicação do tenant;
- falha fechado se o site selecionado não estiver acessível;
- falha fechado se a identidade Operations conseguir ler o site de isolamento, indicando acesso mais amplo que o planejado;
- não publica nomes de listas nem permissões detalhadas no GitHub.

## Regra de merge para deploy produtivo

O workflow de produção consome a proveniência exata dos gates do PR e exige um **merge commit de dois pais** na `main`. PRs que precisem disparar o deploy produtivo devem ser integrados com merge commit normal; `squash` e `rebase` não preservam essa forma de proveniência e são rejeitados pelo deploy.

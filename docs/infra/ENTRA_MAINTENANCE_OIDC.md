# Entra Maintenance via GitHub OIDC

## Objetivo

A identidade **Ecossistema Maintenance - GitHub OIDC** é separada de Operations e existe somente para manutenção delimitada dos dois App Registrations técnicos do Ecossistema.

A fase A é um **dry-run sem mutação**. Ela não cria, altera ou remove certificados, owners, permissões ou applications.

## Menor privilégio

Permissão Microsoft Graph **Application** permitida:

- `Application.ReadWrite.OwnedBy`
- ID: `18a4783c-866b-4cc7-a460-3d5e5662c884`

Não conceder:

- `Application.ReadWrite.All`;
- `Directory.ReadWrite.All`;
- `Directory.Read.All`;
- permissões de administração de app-role assignments.

O dry-run lê os app-role assignments da própria identidade e falha fechado se houver qualquer application permission além de `Application.ReadWrite.OwnedBy`.

## Ownership permitido

O service principal Maintenance deve ser owner **somente** destes application objects:

- Web: `0fcc9402-26bb-4c9d-9ccd-eb4f625cf278`;
- Graph: `2d04bd2b-3ef5-4ac6-bd2e-11885a5b3401`.

O dry-run consulta `ownedObjects` e exige exatamente esses dois IDs. Ownership ausente ou adicional é erro.

## GitHub OIDC

Não criar client secret.

Issuer:

`https://token.actions.githubusercontent.com`

Audience:

`api://AzureADTokenExchange`

O job usa o GitHub Environment `maintenance`. Para este repositório, o subject imutável esperado é:

`repo:mcpmieda@268288370/ecossistema@1345061518:environment:maintenance`

O subject inclui o **nome** do repositório. Depois que o repositório foi renomeado de `ecossistema-escola` para `ecossistema`, a troca OIDC passou a falhar (401) até a credencial federada ser atualizada com o nome novo (os IDs não mudam).

O workflow também falha se não estiver executando sobre `refs/heads/main`.

## GitHub Environment

Criar o environment `maintenance` antes da primeira execução real.

Configuração esperada:

- permitir deploy somente da branch `main`;
- exigir revisão manual para a execução de Maintenance quando o plano permitir;
- não armazenar private key de certificado como secret permanente do job.

Repository Variable adicional:

- `ENTRA_MAINTENANCE_CLIENT_ID` = Client ID do App Registration Maintenance.

As variáveis `ENTRA_TENANT_ID`, `WEB_APPLICATION_OBJECT_ID` e `GRAPH_APPLICATION_OBJECT_ID` já são reutilizadas.

## Fase A — dry-run

O workflow `.github/workflows/entra-maintenance.yml` é manual e:

1. obtém assertion OIDC do GitHub;
2. troca por token Graph de curta duração;
3. confirma que a identidade tem somente `Application.ReadWrite.OwnedBy`;
4. confirma ownership exatamente de Web e Graph;
5. inventaria certificados atuais sem publicar bytes do certificado ou private keys;
6. publica apenas contagens e status sanitizados.

Nenhum método Graph de escrita é usado pelo planner.

## Fase B — rotação A/B

Somente depois de um dry-run real verde.

O runtime existente será reutilizado:

- `WEB_CREDENTIAL_A` / `WEB_CREDENTIAL_B`;
- `GRAPH_CREDENTIAL_A` / `GRAPH_CREDENTIAL_B`;
- seleção do slot mais novo por `createdAt`;
- validação de Web por slot exato;
- validação de Graph por slot exato.

Antes do apply, o dry-run também informa apenas um booleano sanitizado por alvo indicando se o material público dos certificados atuais está disponível para preservação integral. Nenhum byte de certificado é publicado no GitHub.

A implementação de apply deve gerar a nova chave somente no job protegido, adicionar o certificado público preservando certificados válidos existentes, gravar a credencial privada no slot inativo do runtime, provar o slot exato sem fallback e manter o certificado anterior durante a janela de rollback.

## Fase B — apply protegido

O workflow manual passou a oferecer três operações no environment `maintenance`:

- `dry-run`: somente leitura;
- `rotate`: adiciona um novo certificado no slot atualmente inativo, prova autenticação real usando exatamente esse slot, grava a mesma credencial no secret Pages correspondente e dispara o workflow oficial `Deploy Cloudflare Pages` sobre a mesma `main`;
- `finalize`: somente depois de existir deploy `workflow_dispatch` verde posterior ao novo certificado; remove apenas o certificado antigo do mesmo slot e mantém o certificado novo mais o certificado do slot oposto para rollback.

Invariantes do apply:

1. somente os Application Objects Web e Graph oficiais podem ser alvo;
2. `rotate` exige exatamente dois certificados atuais, um A e um B, sem client secret;
3. o slot solicitado precisa ser o inativo segundo `startDateTime`; tentar girar o slot ativo falha fechado;
4. todo certificado atual precisa ter material público legível antes do PATCH;
5. o PATCH envia os certificados atuais junto com o novo para não substituir a coleção por engano;
6. a private key nova existe apenas no runner e no secret Pages do slot selecionado;
7. antes de gravar o secret, o workflow usa o parser/runtime de produção e prova o novo slot contra o Entra sem fallback;
8. se a prova exata ou a gravação do secret falhar, o certificado recém-adicionado é removido automaticamente;
9. depois que o secret foi gravado, falhas posteriores não removem o novo certificado automaticamente, preservando recovery;
10. publicação usa somente o workflow oficial de produção, preservando os gates/proveniência da `main`;
11. `finalize` exige prova de deploy oficial verde posterior ao certificado novo.

Estado inicial comprovado em 2026-09-19:

- Web: B é o slot mais novo; primeira rotação deve usar `target=web`, `slot=A`;
- Graph: A é o slot mais novo; primeira rotação deve usar `target=graph`, `slot=B`.

Executar uma rotação por alvo por vez: `rotate` → conferir run/deploy → `finalize` → próximo alvo.


## Reparo de certificado órfão

Se uma rotação falhar depois de adicionar o novo certificado ao Entra, mas antes de gravar o secret Pages, use `repair-orphan` antes de qualquer nova tentativa de `rotate`.

O reparo falha fechado e só remove o certificado mais novo do slot selecionado quando todas as condições abaixo são verdadeiras:

- o alvo possui exatamente 3 certificados;
- existem exatamente 2 certificados no slot selecionado e 1 no slot oposto;
- o candidato mais novo tem menos de 24 horas;
- não existe deploy manual de produção concluído com sucesso após a criação desse candidato;
- a identidade Maintenance continua restrita aos dois Application Objects oficiais e a `Application.ReadWrite.OwnedBy`.

Depois da remoção, o workflow relê o Entra e exige retorno a exatamente 2 certificados sem password credentials. O reparo não altera secret Pages e não executa deploy.

O rollback automático da operação `rotate` tenta a remoção do certificado novo até 3 vezes. Se ainda assim falhar, o job emite somente um aviso sanitizado e exige `repair-orphan` antes da próxima rotação.

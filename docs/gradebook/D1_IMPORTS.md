# Extensão local de importações V1 no D1

> **Documento histórico.** O D1 acadêmico foi aposentado (#1079) e o código descrito aqui não existe mais. O estado atual está em [STORAGE_RUNTIME_MAP.md](STORAGE_RUNTIME_MAP.md): produção usa PostgreSQL/Supabase via Hyperdrive `PROD_DB`.

Este documento descreve o módulo independente em
`server/gradebook/persistence/d1/imports/`. Ele completa três operações de
`ImportPersistenceRepositoryV1` sobre as migrations locais 0001–0003:

- `listLogicalSourceVersions`;
- `getImportBatch`;
- `appendImportBatchVersion`.

As operações já integradas `findSourceFileByHash`, `getSourceFileVersion` e
`appendSourceFileVersion` não são reimplementadas nem alteradas. A composição da #272 reúne essas
operações e as três extensões deste módulo em uma única `PersistenceUnitOfWorkV1`.

## Limites e autoridade

O módulo é exclusivamente local. Ele não cria banco, binding, secret, endpoint, migration remota ou
recurso de infraestrutura; também não armazena binários. Não há ativação da persistência acadêmica em
produção.

O histórico importado permanece sob autoridade `imported-source`. O adaptador não promove lotes, não
altera `authorityMode`, não substitui valores, não executa reconhecimento de planilhas e não cria
regra acadêmica, tolerância ou arredondamento.

## Versões por fonte lógica

`listLogicalSourceVersions` consulta diretamente a relação normalizada
`source_file_versions.confirmed_logical_source_id`. Nome de arquivo e varredura de `payload_json` não
são usados para descobrir a fonte.

A consulta:

- filtra o ano e a fonte lógica informados;
- retorna somente relações `confirmed`;
- inclui todas as versões históricas confirmadas, inclusive uma versão de metadado causada por
  renomeação com o mesmo hash;
- preserva o payload completo e confere suas colunas normalizadas;
- ordena por `recorded_at`, `manifest_id` e `version`.

A paginação é keyset, sem `OFFSET`. O cursor é opaco e vincula sua versão ao ano, à fonte lógica e à
última chave composta. Um cursor não pode ser reutilizado em outro ano ou fonte. O limite é inteiro
positivo e nunca supera 100.

## Lotes e manifestos

O lote corrente é localizado por `import_batch_streams.current_version`. A reconstrução combina:

- status, resumo e instantes de `import_batch_versions`;
- arquivos de `import_batch_files`, ordenados por `import_file_id`;
- diagnósticos de `import_diagnostics`, ordenados por `diagnostic_id`;
- o manifesto da versão exata referenciada em `source_file_versions`.

Payload, resumo e colunas normalizadas são conferidos entre si. A versão corrente não é substituída
silenciosamente quando a linha histórica ou uma referência está quebrada.

Arquivos com manifesto `null` continuam distintos de arquivos reconhecidos. Estados `received`,
`processing`, `review-required`, `approved`, `rejected` e `failed` são preservados; um lote misto não
converte revisão, rejeição ou falha individual em sucesso. O resumo é validado contra os arquivos e
diagnósticos persistidos, inclusive para impedir aparência de aprovação diante de erro bloqueante ou
crítico.

Diagnósticos preservam localização de arquivo, guia ou célula, evidência de origem e referência de
entidade quando presentes. Cada ID listado pelo arquivo precisa corresponder ao diagnóstico daquela
mesma versão do lote.

## Escrita, CAS e rollback

`appendImportBatchVersion` usa comparação e troca:

- `expectedVersion: null` cria somente lote ausente;
- uma expectativa positiva avança somente a raiz que ainda possui aquela versão;
- conflito retorna `version-conflict` com a versão corrente, sem acrescentar histórico, arquivo ou
  diagnóstico.

Antes de persistir uma referência, o adaptador encontra no mesmo ano a versão histórica cujo
manifesto completo corresponde ao manifesto do arquivo. A FK liga arquivos e diagnósticos a essa
versão exata, não necessariamente à versão corrente posterior do stream.

Raiz, versão do lote, arquivos e diagnósticos são gravados no mesmo savepoint. Falha de FK, `CHECK`,
JSON, shape, duplicidade ou referência reverte integralmente a tentativa, inclusive o avanço da raiz.
O histórico anterior permanece append-only.

## Erros sanitizados

Erros públicos usam códigos e mensagens fixos. SQL, parâmetros, nomes, identificadores, payload
acadêmico e mensagens brutas do driver não são propagados. JSON inválido, linha incompatível,
referência quebrada, manifesto ausente e falha física permanecem casos explícitos e distintos.

## Verificação

Os testes em `tests/gradebook/persistence/d1-imports/` usam somente dados sintéticos e cobrem:

- versões históricas, renomeação com o mesmo hash, isolamento anual e cursores;
- lotes aprovado, misto, em revisão e rejeitado;
- manifesto histórico exato, manifesto ausente e manifesto de outro ano;
- localização e evidência diagnóstica;
- criação, atualização, CAS e histórico;
- duplicidades, rollback, JSON/shape incompatível e erro sanitizado;
- determinismo e não mutação das entradas.

A validação final deve executar `npm run verify` no SHA final do PR.

O teste composto em `tests/gradebook/persistence/d1-composition/` confirma fonte, histórico e lote
pelo mesmo objeto usado por entidades, registros, associações e Auditoria.

## Limite de bootstrap V2 — contrato da #413

A migration 0001 já contém `logical_sources`, suas FKs acadêmicas e o índice de contexto. A #413 não
altera migration nem adaptador D1 concreto; fecha apenas `LogicalSourceRepositoryV2`,
`PersistenceUnitOfWorkV2` e `ImportBootstrapTransactionPortV2` para implementação pela #410.

O adapter futuro deve listar por `academic_year_id + teacher_id + source_context` com limite 2 para
distinguir criação, reutilização única e ambiguidade. A criação inicial deve ocorrer dentro da mesma
transação do manifesto/lote/promoção e ser idempotente para o mesmo ID/contexto. Cross-year, colisão ou
uma fonte concorrente compatível falham sem commit parcial.

O lote inicial é server-owned, usa `expectedVersion: null` e materializa a versão 1 esperada pelo
planner. O hash/manifesto não pode ser persistido antes do planejamento. A implementação #410 deve
aplicar, no mesmo UoW D1, fonte lógica (se nova) → versão de fonte planejada → lote → componentes →
registros → associações, reutilizando o executor/CAS atual. Este documento não afirma que esse adapter
ou runtime V2 já esteja operacional.

# Adaptador D1 local de leitura V1

> **Documento histórico.** O D1 acadêmico foi aposentado (#1079) e o código descrito aqui não existe mais. O estado atual está em [STORAGE_RUNTIME_MAP.md](STORAGE_RUNTIME_MAP.md): produção usa PostgreSQL/Supabase via Hyperdrive `PROD_DB`.

## Escopo

Este adaptador implementa somente as leituras necessárias ao planejamento idempotente de importação e reimportação. Ele recebe uma instância D1 por interface estrutural, não cria binding, banco ou recurso e não executa migrations em produção.

O domínio e as portas públicas continuam independentes de Cloudflare. A implementação externa fica em `server/gradebook/persistence/d1/read/d1-read-adapter-v1.ts`.

## Leituras implementadas

| Porta/operação                                    | Fonte relacional                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `findSourceFileByHash`                            | stream atual e versão corrente de `source_file_streams`/`source_file_versions`, sempre filtrados por ano e hash |
| `getSourceFileVersion`                            | manifesto e versão exatos, sempre filtrados por ano                                                             |
| `AcademicRecordRepositoryV1.getCurrent`           | stream e versão corrente de `academic_record_streams`/`academic_record_versions`, filtrados por ano e chave     |
| `LogicalSourceRecordCatalogV1.listCurrentStreams` | relações `active` em `logical_source_record_streams`, confirmadas contra o stream acadêmico do mesmo ano        |

Os candidatos de uma versão de arquivo são carregados de `source_file_logical_source_candidates`. A relação catálogo ↔ registro usa exclusivamente colunas normalizadas; nome de arquivo e varredura de JSON não participam da consulta.

## Reconstrução dos contratos

O adaptador valida tipos escalares, inteiros positivos, trimestre, discriminantes e JSON antes de retornar contratos. O payload preservado recompõe os campos públicos; as colunas normalizadas confirmam identidade, ano, versão atual, fonte lógica, autoridade, versão da regra e chave canônica do stream.

A chave acadêmica é recalculada pelas funções canônicas do planejador. Divergência entre payload, colunas ou chave solicitada é tratada como linha incompatível. Uma associação ativa sem stream acadêmico correspondente é tratada como referência quebrada, em vez de ser silenciosamente omitida.

Falhas externas são convertidas em `GradebookD1ReadErrorV1`, com códigos estáveis:

- `database-read-failed`;
- `invalid-json`;
- `incompatible-row`;
- `broken-reference`.

As mensagens são fixas e sanitizadas: SQL, parâmetros, payload acadêmico e mensagem bruta do banco não são incluídos.

## Catálogo por fonte lógica

`listCurrentStreams` filtra por `academic_year_id`, `logical_source_id` e `current_state = 'active'`, e ordena por `record_kind, stream_key`. O índice parcial `idx_logical_source_record_streams_current` cobre esse acesso.

O recebimento de uma nova planilha não altera o catálogo. Uma associação que não aparece na nova origem permanece ativa até uma decisão explícita de escrita/promoção registrar nova versão e estado.

## Verificação local

`tests/gradebook/persistence/d1-read-adapter/d1-read-adapter-v1.test.ts` adapta `node:sqlite` à mesma interface estrutural usada pelo D1 e cria um banco `:memory:` descartável. A suíte:

1. aplica e reaplica as migrations 0001–0003;
2. usa somente dados sintéticos;
3. verifica FKs anuais, ausência de cascata, histórico e plano indexado;
4. exercita as quatro leituras e a reconstrução dos contratos;
5. injeta JSON, shapes e referências inválidos para validar erros controlados;
6. confirma que mensagens do driver e dados de entrada não vazam nos erros.

Nenhum recurso remoto, segredo, binding ou migration persistente é criado.

## Limitações deliberadas

Esta entrega não implementa escrita, compare-and-set, promoção transacional, autorização, endpoint, runner operacional de migrations ou provisionamento D1. A escrita futura deverá atualizar raiz e histórico atomicamente e registrar qualquer ativação/inativação como decisão explícita.

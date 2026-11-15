# Schema D1 V1 do Banco de Notas

> **Documento histórico.** O D1 acadêmico foi aposentado (#1079) e o código descrito aqui não existe mais. O estado atual está em [STORAGE_RUNTIME_MAP.md](STORAGE_RUNTIME_MAP.md): produção usa PostgreSQL/Supabase via Hyperdrive `PROD_DB`.

## Estado e limite

O catálogo canônico de código/local está integrado até a migration 0005. As migrations 0001–0005 resultam em schema version 5 / 27 tabelas em local/preview e testes sintéticos.

A #399 aplicou exclusivamente a 0005 ao D1 acadêmico produtivo depois de confirmar registry 0001–0004, schema 4 / 25, ausência das tabelas novas e gate OFF. A produção remota está agora em migrations 0001–0005, schema version 5 / 27 tabelas e zero pendência. A operação não abriu o production gate, não usou dados acadêmicos e não executou piloto.

O domínio permanece independente de D1. Adaptadores convertem contratos e portas em SQL sem expor tabelas aos consumidores.

## Migrations registradas

| Versão | Arquivo                                          | Responsabilidade                                                                 |
| -----: | ------------------------------------------------ | -------------------------------------------------------------------------------- |
|      1 | `0001_gradebook_context_entities_imports_v1.sql` | anos/configurações, entidades, fontes, manifestos, lotes e diagnósticos          |
|      2 | `0002_gradebook_records_audit_v1.sql`            | registros acadêmicos, reconciliação, ocorrências e transições de Auditoria       |
|      3 | `0003_logical_source_record_catalog_v1.sql`      | associação anual/versionada entre fonte lógica e stream acadêmico                |
|      4 | `0004_bulletin_council_durability_v1.sql`        | snapshots de Boletins e decisões de Conselho, streams + versões                  |
|      5 | `0005_council_session_durability_v2.sql`         | sessão/reunião institucional V2, estado/votos/fechamento/histórico cross-restart |

As migrations usam criação condicional e registro idempotente em `gradebook_schema_migrations`. `GRADEBOOK_D1_READ_ADAPTER_MIGRATIONS` contém a ordem integral 0001–0005 e é a referência do runner local/preview e do runtime para detectar pendência.

Após 0005 existem **27 tabelas** no catálogo local atual. Produção continua em 25 até aplicação remota autorizada da 0005.

## Princípios físicos

- IDs de domínio são `TEXT` opacos; nomes não participam de chaves técnicas;
- relações acadêmicas incluem `academic_year_id` e impedem referências entre anos;
- streams mantêm `current_version` para controle otimista;
- histórico fica em tabelas `*_versions` append-only;
- nenhuma FK usa `ON DELETE CASCADE`;
- payload contratual completo pode ser preservado em JSON válido sem tornar JSON fonte de descoberta relacional;
- nome do arquivo é metadado versionado; SHA-256 identifica conteúdo;
- binários não fazem parte do schema;
- não existe purge/retention automática inventada.

## Catálogo de tabelas 0001–0003

### Contexto e entidades

`gradebook_schema_migrations`, `academic_years`, `academic_year_configuration_versions`, `academic_year_versions`, `academic_entity_streams`, `academic_entity_versions`.

### Fonte e importação

`logical_sources`, `source_file_streams`, `source_file_versions`, `source_file_logical_source_candidates`, `import_batch_streams`, `import_batch_versions`, `import_batch_files`, `import_diagnostics`.

Mesmo hash renomeado não cria outra identidade acadêmica. Hash diferente exige confirmação de fonte lógica quando o contexto não for inequívoco.

### Registros acadêmicos

`academic_record_streams`, `academic_record_versions` para `grade-entry`, `term-result`, `final-recovery` e `annual-result`.

### Catálogo por fonte lógica

`logical_source_record_streams`, `logical_source_record_versions`.

Item ausente em uma nova versão não é desativado automaticamente. Estado `inactive` exige decisão explícita e nova versão da associação.

### Reconciliação e Auditoria

`audit_record_streams`, `audit_record_versions`, `audit_occurrence_transitions`.

## Migration 0004 — durabilidade F7/F8

A #340 adiciona exatamente quatro tabelas:

| Tabela                       | Papel                                                                   |
| ---------------------------- | ----------------------------------------------------------------------- |
| `bulletin_snapshot_streams`  | raiz/versionamento do snapshot de Boletim                               |
| `bulletin_snapshot_versions` | histórico imutável do snapshot, contexto e payload canônico             |
| `council_decision_streams`   | raiz/versionamento da decisão por aluno/turma/ano                       |
| `council_decision_versions`  | histórico append-only da decisão humana, justificativa, ator e instante |

A 0004 não persiste a sessão/reunião institucional V2. Essa limitação histórica foi classificada como `blocks-pilot` pela #394 e é removida no catálogo de código pela 0005/#395, sem reinterpretar as quatro tabelas V1.

### Access patterns e índices 0004

A 0004 inclui índices para:

- histórico de snapshot por `snapshot_id`/versão;
- paginação de snapshots por ano/turma/aluno;
- paginação de snapshots por ano/turma;
- histórico de decisão por ano/turma/aluno e versão.

## Migration 0005 — sessão institucional V2 durável

A #395 adiciona exatamente duas tabelas, sem alterar shared contracts:

| Tabela                     | Papel                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `council_session_streams`  | raiz por `academic_year_id + class_reference`, estado `open/closed` e versão atual |
| `council_session_versions` | estado versionado append-only contendo votos opcionais e snapshot de fechamento    |

A porta `CouncilSessionStoreV2` permanece provider-independent. O adapter D1 passa a preservar:

- estado da reunião e versão/CAS;
- votos opcionais já registrados;
- snapshot imutável de fechamento;
- histórico de fechamento;
- bloqueio pós-fechamento após reinstanciação do adapter/runtime.

A versão 0 aberta continua implícita quando não existe stream. O primeiro write cria versão 1; versões seguintes preservam `previous_version = version - 1`. Fechamento não expõe reabertura implícita.

O índice `idx_council_session_versions_history` atende histórico por ano/turma/estado/versão. `closure_reference` possui índice único parcial quando presente. Não há leitura por aluno para carregar sessão ou histórico.

## Versionamento e compare-and-set

O adaptador de escrita executa atomicamente:

1. ausência de stream + versão esperada 0: cria raiz em versão 1;
2. stream existente: atualiza raiz somente quando `current_version` e estado esperado ainda correspondem;
3. zero linhas atualizadas: conflito de concorrência;
4. acrescenta a nova versão histórica com `previous_version` correta;
5. confirma raiz e histórico juntos; qualquer erro reverte tudo.

Continuidade:

```text
versão 1  → previous_version IS NULL
versão N  → previous_version = N - 1
```

A disciplina vale para snapshots, decisões V1 e sessão V2: append-only, imutabilidade e optimistic concurrency transacional. Bindings remotos com `batch()` usam os guards da camada de durabilidade; SQLite local usa savepoint.

## Associação transacional de fonte

A associação fonte lógica ↔ stream continua explícita e na mesma UoW de fonte/registro:

```text
versão de fonte
      ↓
versão do registro acadêmico
      ↓
versão da associação fonte ↔ stream
      ↓
commit único
```

Conflito em qualquer etapa provoca rollback integral. As migrations 0004/0005 não alteram essa semântica.

## Leitura/escrita integrada

O runtime local/preview com schema 5 dispõe de:

- entidades, fontes, lotes, registros e associações;
- Audit Workspace e transições;
- read models operacionais e Performance;
- projeção oficial de Conselho #332;
- `GradebookD1BulletinSnapshotRepositoryV1`;
- `GradebookD1CouncilDecisionStoreV1`;
- `GradebookD1CouncilSessionStoreV2`.

Boletim histórico/reprint lê o snapshot persistido e não relê dados acadêmicos atuais. Conselho recupera decisões V1 e sessão institucional V2 após reinstanciação do adapter/runtime no mesmo D1.

## Verificação local

As suítes aplicam/reaplicam 0001–0005 em SQLite em memória e verificam:

- idempotência das migrations;
- 27 tabelas após aplicação integral local;
- FKs e isolamento anual;
- ausência de cascades destrutivos;
- histórico e continuidade de versão;
- hash, renomeação e fontes candidatas;
- registros acadêmicos e Auditoria;
- associação fonte ↔ stream;
- snapshot/decision append, CAS e recuperação após reinstanciação;
- sessão V2, voto, fechamento, histórico e guard pós-fechamento após restart;
- paginação/bounds e índices aplicáveis;
- nenhuma DDL fora de migration;
- nenhuma operação remota.

Somente dados sintéticos são usados.

## Produção

Estado remoto confirmado pela #399:

- D1 acadêmico produtivo: presente e associado ao binding protegido;
- binding `GRADEBOOK_D1`: presente;
- migrations remotas aplicadas: 0001–0005, 5/5;
- schema remoto: version 5 / **27 tabelas de domínio**;
- migrations pendentes: 0;
- `council_session_streams` e `council_session_versions`: presentes com FKs e índices canônicos;
- catálogo físico remoto: 27/27 tabelas esperadas, sem faltantes ou extras;
- smoke sintético da onda 23: verde no schema 4/25 então vigente;
- recovery pós-smoke: corpus sintético restaurado para zero raízes residuais;
- production gate final: OFF;
- piloto real: não iniciado;
- `authorityMode: imported-source`.

A #399 executou somente migration + inspeção. O smoke produtivo sintético da sessão V2, incluindo recovery integral do corpus, permanece na #400. A presença do schema 5 não autoriza piloto nem abertura permanente do runtime.

# Entidades acadêmicas V1 no D1 local

> **Documento histórico.** O D1 acadêmico foi aposentado (#1079) e o código descrito aqui não existe mais. O estado atual está em [STORAGE_RUNTIME_MAP.md](STORAGE_RUNTIME_MAP.md): produção usa PostgreSQL/Supabase via Hyperdrive `PROD_DB`.

Este documento descreve o adaptador local de `AcademicEntityRepositoryV1` implementado em
`server/gradebook/persistence/d1/entities/`. Ele completa a persistência versionada das entidades
acadêmicas sem ativar D1 remoto, criar binding, executar migração remota ou alterar a autoridade dos
dados.

## Escopo e autoridade

O repositório atende exclusivamente estes oito tipos:

- `teacher`;
- `class-group`;
- `subject`;
- `teaching-assignment`;
- `student`;
- `enrollment`;
- `student-status-event`;
- `assessment-component`.

`academic-year` é recusado explicitamente neste módulo com
`academic-year-owned-by-context-adapter`. Sua implementação oficial permanece no adaptador de
contexto anual já integrado. A composição da #272 roteia esse tipo para a implementação da #262 e os
oito tipos deste documento para este repositório, sem concorrência.

O adaptador preserva a autoridade `imported-source`. Ele não substitui valores importados ou nativos,
não altera `authorityMode`, não interpreta decisões pedagógicas e não cria regras acadêmicas,
tolerâncias ou arredondamentos.

## Contrato exposto

A fábrica `createGradebookD1AcademicEntityRepositoryV1(database, options)` devolve o contrato
`AcademicEntityRepositoryV1` e implementa:

- `get(context, reference)`, para recuperar a versão corrente ou `null`;
- `list(context, kind, page)`, para listar versões correntes por cursor;
- `appendVersion(context, record, expectation)`, para criar ou anexar uma versão por comparação e
  troca.

O contexto anual é obrigatório em todas as operações. Entidades anuais também precisam declarar o
mesmo `academicYearId` no payload. Entidades compartilháveis (`teacher`, `subject` e `student`) ainda
são armazenadas em um fluxo isolado pelo ano acadêmico informado no contexto.

## Modelo persistido

Cada identidade corrente fica em `academic_entity_streams`, cuja chave é
`(academic_year_id, entity_kind, entity_id)`. O histórico imutável fica em
`academic_entity_versions`, com uma linha para cada versão.

O payload completo do contrato é preservado em `payload_json`. As colunas normalizadas de relação e
consulta são gravadas junto com ele:

| Tipo                   | Relações normalizadas                    | Campos auxiliares                        |
| ---------------------- | ---------------------------------------- | ---------------------------------------- |
| `teacher`              | —                                        | nome e estado                            |
| `class-group`          | —                                        | código                                   |
| `subject`              | —                                        | código e estado                          |
| `teaching-assignment`  | professor, turma e componente curricular | índice de origem e origem da confirmação |
| `student`              | —                                        | nome                                     |
| `enrollment`           | estudante e turma                        | posição de origem e estado da matrícula  |
| `student-status-event` | matrícula                                | referência de origem e estado            |
| `assessment-component` | associação docente                       | período, nome e aplicabilidade           |

Na leitura, tipo, identidade, ano, versão corrente, forma do payload e todas as colunas normalizadas
são conferidos entre si. Divergências não são reparadas nem mascaradas; produzem erro estável.
Restrições e chaves estrangeiras da migração local continuam sendo a fonte de verdade para relações
entre entidades, inclusive tipo e ano dos alvos.

## Paginação

`list` usa ordenação determinística por `entity_id` e paginação keyset. Não há `OFFSET`. O cursor é
opaco para o chamador e carrega sua versão, o ano, o tipo e a última identidade visitada. Por isso um
cursor não pode ser reutilizado em outro ano ou tipo.

O limite deve ser inteiro positivo e não pode superar 100, mesmo quando a fábrica recebe um máximo
configurado. A implementação consulta um item adicional apenas para decidir se há próxima página.

## Concorrência e atomicidade

`appendVersion` aplica comparação e troca sobre `current_version`:

- `expectedVersion: null` cria somente um fluxo ausente;
- uma versão positiva atualiza somente o fluxo que ainda possui exatamente aquela versão;
- conflito devolve `version-conflict` e a versão corrente, ou `null` quando o fluxo não existe.

A alteração da raiz e a inserção no histórico acontecem no mesmo savepoint. Qualquer falha na linha
histórica, em uma relação ou em uma restrição reverte também a raiz. Assim não existe avanço parcial
de versão.

## Erros e limites operacionais

Erros do adaptador têm códigos e mensagens fixos. Falhas brutas do driver, SQL, payload inválido e
identificadores internos não vazam para o chamador. Entradas incompatíveis são recusadas antes da
escrita sempre que o contrato permite; inconsistências estruturais do banco são recusadas na leitura.

Esta implementação é somente local e não:

- cria ou configura recursos D1;
- altera schema ou migrações;
- ativa persistência acadêmica em produção;
- cria uma segunda implementação para `academic-year`;
- substitui o adaptador oficial de ano acadêmico.

## Verificação

Os testes em `tests/gradebook/persistence/d1-entities/` usam somente dados sintéticos e cobrem os oito
tipos, isolamento anual, histórico, relações, cursores, CAS, rollback, determinismo, não mutação das
entradas e sanitização de falhas. A validação final do repositório deve ser feita com `npm run verify`.

O teste composto em `tests/gradebook/persistence/d1-composition/` exercita os nove tipos pela mesma
UoW usada pelo runtime local/preview.

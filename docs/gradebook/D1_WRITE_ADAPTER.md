# Adaptador D1 local de escrita e promoção transacional V1

> **Documento histórico.** O D1 acadêmico foi aposentado (#1079) e o código descrito aqui não existe mais. O estado atual está em [STORAGE_RUNTIME_MAP.md](STORAGE_RUNTIME_MAP.md): produção usa PostgreSQL/Supabase via Hyperdrive `PROD_DB`.

## Escopo

O adaptador implementa localmente as escritas físicas exigidas por `executeImportChangePlan`, sem criar banco, binding, secret, endpoint, runner de migrations ou recurso remoto. O domínio e o executor continuam consumindo somente as portas públicas V1.

Implementações:

- `createGradebookD1WriteUnitOfWorkV1` em `server/gradebook/persistence/d1/write/d1-write-adapter-v1.ts`;
- `GradebookD1BatchPromotionTransactionV1` em `server/gradebook/persistence/d1/transaction/d1-batch-promotion-transaction-v1.ts`.

O banco descartável dos testes usa `node:sqlite`, habilita `PRAGMA foreign_keys = ON` e aplica `GRADEBOOK_D1_READ_ADAPTER_MIGRATIONS`, o catálogo integral e ordenado das migrations 0001–0003.

## API implementada

A unidade de trabalho reutiliza o adaptador local de leitura para:

- `findSourceFileByHash`;
- `getSourceFileVersion`;
- `AcademicRecordRepositoryV1.getCurrent`;
- `LogicalSourceRecordRepositoryV1.getCurrent`;
- `LogicalSourceRecordRepositoryV1.listCurrentStreams`.

Ela acrescenta as três escritas autorizadas:

- `appendSourceFileVersion`;
- `AcademicRecordRepositoryV1.appendVersion`;
- `LogicalSourceRecordRepositoryV1.appendVersion`.

Entidades, lotes, Auditoria e paginação de históricos não são ampliados nesta entrega. Quando chamados pela unidade local, retornam o erro controlado `unsupported-operation`; não existe implementação silenciosa ou efeito colateral fora do plano.

## Compare-and-set e ordem SQL

Cada append executa em `SAVEPOINT` próprio. Assim, uma falha de shape, JSON, FK, `CHECK`, `UNIQUE` ou resultado do driver não deixa raiz sem histórico nem ponteiro avançado, inclusive quando a escrita é exercitada isoladamente.

Para `expectedVersion: null`:

1. valida o contrato e serializa o payload antes de SQL;
2. tenta `INSERT ... ON CONFLICT DO NOTHING` na tabela de stream, com `current_version = 1`;
3. zero linhas alteradas retorna `version-conflict` com a versão corrente;
4. insere exatamente a versão histórica 1, com `previous_version IS NULL`;
5. insere candidatos explícitos da fonte, quando o estado é `candidate`;
6. libera o savepoint.

Para uma versão existente:

1. executa `UPDATE` da raiz com predicado `current_version = expectedVersion`;
2. zero linhas alteradas consulta e retorna a versão corrente, inclusive `null` quando o stream não existe;
3. acrescenta a versão `expectedVersion + 1` com `previous_version = expectedVersion`;
4. libera o savepoint.

O append acadêmico persiste a chave canônica produzida por `academicRecordStreamKeyV1` e confere que stream, discriminante, ano e payload representam o mesmo registro. O append de associação confere separadamente ano, fonte lógica, chave estável, stream, estado e proveniência do manifesto; não é efeito colateral do registro acadêmico.

## Promoção transacional

`GradebookD1BatchPromotionTransactionV1.runBatchPromotion` executa nesta ordem:

```text
BEGIN IMMEDIATE
  validar lote e current_version
  validar que todos os import_file_id solicitados estão approved
  append da versão de fonte
  para cada item new/changed:
    append do registro acadêmico
    append explícito da associação fonte lógica ↔ stream
COMMIT
```

Qualquer conflito retornado por uma das três portas, falha de constraint, shape incompatível, resultado incompatível ou rejeição da operação provoca `ROLLBACK`. Itens `unchanged`, `missing-from-new-source`, bloqueados ou pertencentes a arquivo em revisão não chegam à transação pelo executor.

A associação aponta para `sourceManifestId` e `sourceManifestVersion` do append de fonte validado e gravado na mesma promoção. O executor continua desconhecendo D1 e SQL.

## Erros sanitizados

Falhas físicas de escrita usam `GradebookD1WriteErrorV1` com códigos estáveis:

- `database-write-failed`;
- `incompatible-write`;
- `unsupported-operation`.

Falhas de controle transacional usam `GradebookD1TransactionErrorV1`:

- `batch-version-conflict`;
- `file-not-approved`;
- `invalid-request`;
- `nested-transaction`;
- `transaction-failed`.

As mensagens são fixas. SQL, parâmetros, payload acadêmico e mensagem bruta do driver não são incorporados. `executeImportChangePlan` mantém seu resultado externo sanitizado para falhas da promoção.

## Verificação local

As suites em `tests/gradebook/persistence/d1-write-adapter/` e `tests/gradebook/persistence/d1-transaction/` cobrem:

- migrations 0001–0003 e FKs ativas;
- criação e atualização de fonte, registro e associação;
- CAS nulo e obsoleto;
- histórico e ponteiros preservados;
- renomeação com somente versão de metadados;
- item novo e alterado no mesmo lote;
- mesmo hash e repetição determinística sem escrita acadêmica/associação;
- arquivos em revisão e itens ausentes sem escrita;
- conflitos de fonte, registro e associação com rollback integral;
- falha de FK/constraint sem raiz ou versão órfã;
- isolamento por ano letivo;
- integração real do planejador e executor com o adaptador físico.

Todos os identificadores, hashes, nomes e valores são sintéticos.

## Limitações deliberadas

- implementação local sobre interface estrutural D1/SQLite;
- nenhuma conexão, sessão ou recurso D1 remoto;
- nenhum binding em `wrangler.jsonc`;
- nenhuma migration aplicada fora do banco descartável de teste;
- nenhuma escrita de entidades, lotes, Auditoria ou status operacional;
- nenhum endpoint, autorização, capability, UI, backup, rollout ou métrica;
- uma conexão local não aceita promoções aninhadas ou concorrentes.

Runtime/binding local ou preview e runner autorizado seguem na #261; o contexto acadêmico global/perfil 2026 segue na #262. Banco, binding e migrations de produção permanecem fora de escopo sem autorização explícita própria.

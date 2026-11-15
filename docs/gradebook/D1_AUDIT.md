# Auditoria e reconciliação V1 no D1 local

> **Documento histórico.** O D1 acadêmico foi aposentado (#1079) e o código descrito aqui não existe mais. O estado atual está em [STORAGE_RUNTIME_MAP.md](STORAGE_RUNTIME_MAP.md): produção usa PostgreSQL/Supabase via Hyperdrive `PROD_DB`.

Este documento descreve `createGradebookD1AuditRepositoryV1`, implementado em
`server/gradebook/persistence/d1/audit/`. O módulo fornece integralmente
`AuditPersistenceRepositoryV1` sobre as migrations locais 0001–0003:

- `getCurrent`;
- `listVersions`;
- `appendVersion`.

As operações atendem ocorrências e reconciliações em um módulo independente. A composição na única
`PersistenceUnitOfWorkV1` pertence à issue integradora da onda.

## Limites e autoridade

O repositório persiste o contrato recebido; ele não calcula equivalência, não cria tolerância, não
arredonda valores e não muda `authorityMode`. Os lados importado e calculado, a classificação
`match`, `expected-difference`, `mismatch` ou `not-comparable`, a regra e a explicação permanecem
intactos no payload.

Ausência, não aplicabilidade, cobertura parcial e dado insuficiente não são promovidos a valores
comparáveis pelo adaptador. Nenhuma decisão pedagógica ou de Conselho é criada ou automatizada.

O módulo é exclusivamente local. Ele não cria banco, binding, secret, endpoint, migration remota,
deploy ou recurso de infraestrutura e usa somente dados sintéticos nos testes.

## Streams e histórico

Cada stream é identificado por `(academic_year_id, audit_kind, audit_record_id)` em
`audit_record_streams`. O histórico append-only fica em `audit_record_versions`, com
`previous_version` contínua.

`getCurrent` liga o ponteiro corrente à versão exata. `listVersions` retorna o histórico em ordem
crescente de versão. A paginação é keyset, sem `OFFSET`; o cursor opaco contém sua versão, ano, tipo,
identidade e última versão. Cursores não podem atravessar ano, tipo ou stream. O limite máximo é 100.

Payload e colunas normalizadas são conferidos em toda leitura. Ponteiro quebrado, JSON inválido,
shape incompatível ou divergência entre payload e coluna falham explicitamente, sem reparo
silencioso.

## Ocorrências e transições

Uma ocorrência começa semanticamente em `open`. Seu `stateHistory` precisa formar uma cadeia válida:

```text
open → acknowledged → resolved
open → acknowledged → dismissed-with-reason
open → resolved
open → dismissed-with-reason
```

`acknowledged` preserva ator, data e nota opcional. `resolved` e `dismissed-with-reason` preservam ator,
data e justificativa obrigatória. O adaptador não preenche nenhum desses campos.

Em uma atualização, o histórico anterior deve ser prefixo estrutural exato do novo histórico. Não é
permitido remover, alterar ou reordenar uma transição já persistida. Somente o sufixo novo é inserido
em `audit_occurrence_transitions`, com sequência contínua. Versões históricas são reconstruídas usando
o prefixo correspondente; a versão corrente deve corresponder a toda a cadeia persistida.

As colunas normalizadas preservam severidade, categoria, estado, lote, entidade e origem. Referências
opcionais são validadas no mesmo ano:

- lote em `import_batch_streams`;
- ano ou entidade acadêmica em sua raiz oficial;
- registro acadêmico por tipo e ID histórico;
- manifesto pela versão exata gravada;
- evidência de célula também contra nome e hash daquela versão do manifesto.

Referências de contrato que não possuem coluna relacional compatível continuam preservadas no payload
e são validadas por consulta explícita; não se cria uma segunda representação de domínio.

## Reconciliações

O alvo da reconciliação é resolvido por ano, tipo e `record_id` para uma única chave de stream
acadêmico. Essa chave é persistida apenas como relação normalizada; o alvo contratual permanece no
payload.

Regras de shape preservadas:

- `match`, `expected-difference` e `mismatch` mantêm `difference` e `tolerance` numéricas exatamente
  como recebidas;
- `not-comparable` mantém `difference: null`, tolerância numérica ou nula e explicação obrigatória;
- valores `official-zero` e `legacy-zero` não são colapsados;
- evidência importada e valor calculado permanecem simultaneamente disponíveis.

O adaptador não decide a classificação e não transforma dado insuficiente em diferença.

## CAS e atomicidade

`appendVersion` aplica comparação e troca:

- `expectedVersion: null` cria somente stream ausente;
- uma expectativa positiva avança somente a raiz naquela versão;
- conflito devolve a versão corrente, inclusive `null`, sem criar histórico ou transição.

Raiz, versão e transições novas são gravadas no mesmo savepoint. Validação de referência, FK, `CHECK`,
JSON ou transição posterior à alteração da raiz reverte a tentativa inteira. Nenhuma transição órfã é
confirmada.

## Erros sanitizados

O repositório usa códigos e mensagens fixos. SQL, parâmetros, identificadores, nomes, notas, payload
acadêmico e mensagens brutas do driver não são expostos. Histórico de transição inválido, referência
quebrada, linha incompatível e falha física permanecem diagnósticos distintos.

## Verificação

Os testes em `tests/gradebook/persistence/d1-audit/` cobrem, com dados sintéticos:

- ocorrência aberta, reconhecimento, resolução e descarte;
- ator, data, nota e justificativa;
- salto, remoção e reescrita de histórico;
- referências válidas, ausentes e isoladas por ano;
- as quatro classificações de reconciliação e os estados distintos de zero;
- criação, atualização, CAS, histórico paginado e cursores;
- rollback, JSON/shape/coluna divergente e erro sanitizado;
- determinismo e não mutação.

A validação final deve executar `npm run verify` no SHA final do PR.

A composição da #272 fornece este repositório como a única implementação de
`AuditPersistenceRepositoryV1` na UoW local/preview. As classificações `match`,
`expected-difference`, `mismatch` e `not-comparable` permanecem dados recebidos e validados; a
composição não decide, corrige ou arredonda nenhuma delas.

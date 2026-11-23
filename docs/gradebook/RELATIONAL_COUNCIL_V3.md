# Conselho relacional V3 — contrato #648

Execução FINAL-3 #635. A autoridade desta superfície é
`calculated-eligibility-explicit-human-decision`: o sistema calcula e explica a
elegibilidade a partir do mesmo read model relacional de Desempenho, mas nunca
transforma esse cálculo em deliberação humana.

## Semântica vigente

- contexto único e explícito: ano letivo 2026;
- decisões persistidas: `APROVADO PELO CONSELHO`, `REPROVADO PELO CONSELHO` e
  `REPROVADO POR FALTA`;
- votação opcional registra somente votos favoráveis e contrários; presentes é
  sempre a soma derivada e não é fato persistido;
- empate e eventual voto de minerva do diretor são resolvidos fora do sistema,
  durante a reunião. Não há identidade, campo, ação ou histórico de desempate;
- só o estado atual é guardado (BN-DEC-049, #1558): a sessão, a decisão e a
  contagem de votos de cada aluno. Uma informação nova substitui a atual; não há
  linha do tempo, histórico nem fotografia de fechamento;
- abrir, fechar e reabrir a reunião não levam justificativa; decisão e contagem
  de votos levam;
- a lista de turmas pode trazer, a pedido (`tally: true`), a contagem de
  aprovados, reprovados (pelo Conselho ou por falta) e pendentes de cada turma;
- `conselho_anterior` não participa da elegibilidade nem da interface ativa. As
  colunas históricas existentes são preservadas fisicamente, sem backfill;
- somente a capability `gradebook.persistence.admin` acessa a rota, sempre com
  autenticação server-side e `Cache-Control: no-store`.

## Sessão e concorrência

Uma turma começa em `not-opened`. Abertura, decisão, votação, fechamento e
reabertura exigem chave de idempotência e versão esperada. Desde a BN-DEC-049
(#1558), abertura, fechamento e reabertura não levam justificativa e o contrato
recusa o campo nesses comandos; decisão e votação continuam exigindo. Na linha de
idempotência desses três comandos, a coluna `justificativa` (`NOT NULL`) recebe o
texto fixo `sem justificativa`. Escritas de decisão e votação são aceitas
somente com a sessão aberta. Cada comando avança uma versão global da sessão sob
transação `SERIALIZABLE`; leituras usam `REPEATABLE READ, READ ONLY`.

O fechamento requer zero estudantes elegíveis pendentes e a mesma referência de
revisão exibida ao operador. Ele só muda o estado da sessão; não grava
fotografia. Reabrir permite novo fechamento. Uma decisão ou contagem nova
substitui a anterior: não há histórico de sessão, decisão ou votação.

A resposta da turma traz `session` como `{ state, version, reviewReference }`.
Saíram `timeline`, `closures`, `session.closedAt`, `session.snapshotCount` e
`decision.version`. Os estados de falha não mudaram (`closure-blocked` e
`review-conflict` continuam). O contrato segue `contractVersion: 3`.

## Persistência mínima

O serviço grava somente em `conselho_sessao` (estado e versão),
`conselho_decisao` (decisão atual, substituída quando muda), `conselho_votacao`
(contagem atual) e `conselho_idempotencia`.

`migrations/gradebook-simplified/0003_council_session_v3.sql` acrescentou oito
tabelas e quatro sequências ao schema relacional da época; a `0023` remove cinco
dessas tabelas e as quatro sequências (ver a seção de 23/11/2026). A migration é
transacional, não remove ou converte colunas, não altera linhas acadêmicas, não
faz backfill e concede acesso somente à role backend `gradebook_app`.
`0004_council_v3_least_privilege.sql` neutraliza permissões DML herdadas dos
default privileges do proprietário e preserva somente SELECT/INSERT e os UPDATEs
necessários às duas tabelas correntes; históricos e fotografias não recebem
UPDATE/DELETE.

A aplicação exige preflight com as oito tabelas ausentes, cópia recuperável do
estado anterior e revisão do SQL exato. Depois da aplicação, validar as tabelas,
sequências, FKs, ACLs, contagens centrais e a permanência exclusiva do ano 2026.
Falha antes do `COMMIT` reverte a migration inteira. Reexecução depois de sucesso
deve falhar de forma visível; não há `IF NOT EXISTS` que mascare drift.

## Aplicação controlada em 11/09/2026

O plano Free não oferecia backup gerenciado. Antes do DDL foi criado um export
lógico local das 20 tabelas e 8 sequências existentes; os 21 conjuntos, payloads
JSON, contagens e checksum foram validados. Isso reduz risco operacional, mas não
é prova de restore institucional nem substitui o gate de recuperação #406/#596.

O preflight encontrou somente 2026, 384 alunos, 15 turmas, zero decisões e as
oito tabelas-alvo ausentes. Após `0003` e a correção de ACL `0004`, o catálogo
tem 28 tabelas, 214 colunas, 188 constraints, 58 índices, 48 FKs e 12 sequências;
funções e triggers anteriores permaneceram 4 e 3. As oito tabelas novas estavam
vazias. Contagens de aluno/turma/nota/fechamento/importação e o único registro de
2026 permaneceram iguais; nenhum outro ano foi criado.

O postflight também confirmou 18 grants de tabela esperados para
`gradebook_app`, zero ausentes ou adicionais, USAGE/SELECT sem UPDATE nas quatro
sequências novas, zero privilégios `PUBLIC` e ausência de campos de
presentes/diretor/desempate.

## Só o estado atual — 23/11/2026

Decisão do responsável na BN-DEC-049 (#1558).
`migrations/gradebook-simplified/0023_council_current_state_only_v1.sql` remove a
coluna `conselho_sessao.fechamento_atual_id` e seis tabelas:
`conselho_fechamento_item`, `conselho_fechamento`, `conselho_sessao_historico`,
`conselho_votacao_historico` e `conselho_decisao_comando` (da `0003`) e
`conselho_decisao_historico` (da baseline). Nenhuma view, função ou trigger
depende delas e nenhum outro módulo as lê. As linhas são descartadas junto, com
autorização do responsável; em 23/11/2026 uma contagem somente leitura mostrou
zero linhas em todas as tabelas do Conselho na produção.

A migration está na árvore e no plano de recuperação
(`GRADEBOOK_CURRENT_SCHEMA_PLAN_V1`), mas **ainda não foi aplicada em produção**.
Ordem: publicar o código primeiro e aplicar a migration depois, porque o código
publicado antes desta mudança ainda lê essas tabelas.

Catálogo depois dela, medido em banco descartável: 22 tabelas, 167 colunas, 152
constraints, 47 índices, 38 FKs, 9 sequências, 4 funções e 3 triggers (antes: 28
tabelas, 233 colunas, 203 constraints, 65 índices, 48 FKs e 13 sequências). Ficam
`conselho_sessao`, `conselho_idempotencia` e `conselho_votacao` (da `0003`), além
de `conselho_decisao` e `conselho_anterior_historico` (baseline, sem alteração).

Reset anual, exclusão de aluno, verificação PostgreSQL do CI e catálogo de
recuperação já seguem a nova lista de tabelas.

## Limites do aceite

Testes PGlite/HTTP/React cobrem contrato, grants, ciclo completo, reabertura,
idempotência, CAS, autorização e estados da interface. Eles não
substituem restauração institucional, ensaio de contenção PostgreSQL
multi-sessão, aceite acadêmico #347 nem a validação visual única com o
responsável. Boletins seguem a adaptação própria #654; Relatórios continuam pendentes na FINAL-1.

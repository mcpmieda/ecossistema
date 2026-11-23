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
- `conselho_anterior` não participa da elegibilidade nem da interface ativa. As
  colunas históricas existentes são preservadas fisicamente, sem backfill;
- somente a capability `gradebook.persistence.admin` acessa a rota, sempre com
  autenticação server-side e `Cache-Control: no-store`.

## Sessão, concorrência e histórico

Uma turma começa em `not-opened`. Abertura, decisão, votação, fechamento e
reabertura exigem chave de idempotência e versão esperada; todas, menos a abertura,
exigem justificativa. Desde a BN-DEC-049 (#1558) a abertura dispensa justificativa:
sem ela, o histórico da sessão e a idempotência gravam o registro fixo
`Abertura da reunião.`, sem mudança de DDL. Escritas
de decisão e votação são aceitas somente com a sessão aberta. Cada comando avança
uma versão global da sessão sob transação `SERIALIZABLE`; leituras usam
`REPEATABLE READ, READ ONLY`.

O fechamento requer zero estudantes elegíveis pendentes e a mesma referência de
revisão exibida ao operador. Ele grava um cabeçalho e um item imutável por aluno,
com elegibilidade, motivo, decisão e contagem de votos daquele instante. Reabrir
exige justificativa, preserva fotografias anteriores e permite novo fechamento.
Históricos de sessão, decisão e votação são append-only.

## Persistência mínima

`migrations/gradebook-simplified/0003_council_session_v3.sql` acrescenta oito
tabelas e quatro sequências ao schema relacional vigente. A migration é
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

## Limites do aceite

Testes PGlite/HTTP/React cobrem contrato, grants, ciclo completo, reabertura,
fotografias, idempotência, CAS, autorização e estados da interface. Eles não
substituem restauração institucional, ensaio de contenção PostgreSQL
multi-sessão, aceite acadêmico #347 nem a validação visual única com o
responsável. Boletins seguem a adaptação própria #654; Relatórios continuam pendentes na FINAL-1.

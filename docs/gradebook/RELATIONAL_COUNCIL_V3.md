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
- a reunião de uma turma só abre, sem justificativa; não existem fechar nem
  reabrir. A turma aparece como concluída quando todos os elegíveis têm decisão:
  é um estado derivado, não gravado, e a decisão pode mudar a qualquer momento,
  mesmo depois disso;
- antes de a reunião estar aberta nada pode ser inserido, só visualizado. É a
  regra para as funções de decisão e contagem que serão refeitas; hoje `open` é o
  único comando de escrita;
- turma sem alunos elegíveis não tem reunião a abrir: a tela não mostra o botão;
- a elegibilidade é calculada na hora, pelas notas, sem trava no sistema: uma
  nota corrigida que chegue durante o Conselho muda a lista. O controle é
  operacional e fora do sistema (ver a seção de 23/11/2026);
- a lista de turmas pode trazer, a pedido (`tally: true`), a contagem de
  aprovados, reprovados (pelo Conselho ou por falta) e pendentes de cada turma;
- `conselho_anterior` não participa da elegibilidade nem da interface ativa. As
  colunas históricas existentes são preservadas fisicamente, sem backfill;
- somente a capability `gradebook.persistence.admin` acessa a rota, sempre com
  autenticação server-side e `Cache-Control: no-store`.

## Sessão e concorrência

Uma turma começa em `not-opened`. O único comando de escrita é `open`, com
`{ year, classId }`: não leva versão esperada, chave de idempotência nem
justificativa, e o contrato estrito recusa esses campos. Ele insere a linha de
`conselho_sessao` (estado 1, versão 1) com `ON CONFLICT DO NOTHING`; abrir de
novo responde a reunião já aberta, portanto o comando é idempotente e duas
aberturas simultâneas terminam as duas em `ready`. Uma linha com estado 2,
fechada pela versão anterior, é lida como aberta. `open` roda em transação
`SERIALIZABLE`, sob o bloqueio de escritor do reset do ano e com uma nova
tentativa em SQLSTATE 40001; leituras usam `REPEATABLE READ, READ ONLY`.

Abrir registra a escrita para o reset do ano sem mudança acadêmica: a versão de
dados do Portal não muda e a rota não dispara mais o aviso pós-commit ao Portal.
Não há fechamento nem reabertura. "Concluída" não é estado da sessão: a tela a
deriva de `session.state: 'open'` com `summary.pending` igual a zero. Uma decisão
nova substitui a anterior: não há histórico de sessão, decisão ou votação.

Requests: `classes` (`year`, `offset`, `limit` e `tally` opcional), `workspace` e
`open` (os dois com `{ year, classId }`). A resposta da turma traz `session` como
`{ state }`, com `not-opened | open`; em `classes`, `sessionState` tem os mesmos
dois valores. Saíram `close`, `reopen`, `reviewReference`, `session.version`,
`sessionVersion`, `currentVersion`, `expectedVersion` e `idempotencyKey`, além de
`timeline`, `closures`, `session.closedAt`, `session.snapshotCount` e
`decision.version`, retirados antes. Saíram também as falhas `version-conflict`,
`idempotency-conflict`, `session-not-open`, `session-already-open`,
`session-closed`, `closure-blocked` e `review-conflict`; restam
`invalid-request`, `not-authorized`, `not-found`, `unavailable` e
`scope-too-large`. HTTP: 200, 400, 404, 422 (`scope-too-large`) e 503; não há
mais 409. O contrato segue `contractVersion: 3`.

## Persistência mínima

O serviço grava somente em `conselho_sessao`, e só ao abrir a reunião (estado 1,
versão 1; a linha não é mais atualizada). `conselho_decisao` é só lida (decisão
atual). `conselho_votacao` e `conselho_idempotencia` ficam sem uso pelo código.
As quatro tabelas permanecem no banco.

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

Em refação desde 23/11/2026 (BN-DEC-049): as funções de registrar decisão, registrar contagem e
listar não elegíveis saíram da tela, do contrato (`decision`, `vote`, campo `vote`) e do serviço.
A decisão atual continua sendo lida de `conselho_decisao`; `conselho_votacao` não é lida nem
gravada. Nenhuma tabela foi alterada por isso.

## A reunião só abre — 23/11/2026

Complemento do responsável à BN-DEC-049 (#1558, PR rascunho #1559), no mesmo dia:

- a reunião de uma turma só abre. "Fechar" e "Reabrir" não existem mais; a turma
  aparece como concluída sozinha quando todos os elegíveis têm decisão, e a
  decisão pode mudar a qualquer momento, mesmo depois disso;
- antes de a reunião estar aberta, nada pode ser inserido, só visualizado;
- turma sem alunos elegíveis não tem reunião a abrir;
- a elegibilidade continua calculada na hora, pelas notas. Se uma nota corrigida
  chegar durante o Conselho, a lista muda. Não há trava no sistema: os alunos
  serão reconferidos antes de a decisão terminar e a escola combinou não enviar
  notas ao sistema nesse período;
- sem histórico, não há como desfazer uma troca de decisão por engano: risco
  aceito pelo responsável;
- divulgação ao aluno: como a decisão vale assim que registrada, haverá
  futuramente um controle interno para mostrar o resultado no Portal a partir de
  uma data. **Não implementado**; só registrado como intenção.

Tela: a linha "Reunião" mostra o estado (Ainda não iniciada, Aberta ou Concluída)
e o botão "Abrir reunião" só enquanto a reunião não está aberta e só em turma com
elegíveis. A fila tem dois grupos empilhados, "A deliberar" e "Decididos", que
viram faixas horizontais em telas estreitas; o resumo de quatro números fica em
uma linha também no celular. Nos botões de turma, as contagens têm forma além da
cor (✓ aprovados, ✕ reprovados, ● pendentes), um marcador enquanto a contagem não
chegou e um aviso quando a leitura da turma falhou. As últimas contagens lidas
ficam guardadas enquanto o Centro está aberto e aparecem de imediato ao voltar à
aba, sendo substituídas pela leitura seguinte.

As contagens das outras turmas continuam atualizadas só ao entrar na aba; a turma
aberta se atualiza sozinha. Foi mantido assim porque reler todas as turmas custa
uma leitura inteira por turma: em 23/11/2026, no banco de produção com os dados
de 2025, de 45 a 70 ms só na consulta das notas de cada turma (#1560), fora as demais
consultas e o transporte.

Nenhuma migration nova. `conselho_idempotencia` e `conselho_votacao` ficam sem
uso pelo código e `conselho_decisao` é só lida; as três entram na lista do que
revisar com o responsável antes de integrar, junto com a `0023`.

## Limites do aceite

Testes PGlite/HTTP/React cobrem contrato, grants, abertura da reunião (inclusive
repetida), contagens por turma, autorização e estados da interface. Eles não
substituem restauração institucional, ensaio de contenção PostgreSQL
multi-sessão, aceite acadêmico #347 nem a validação visual única com o
responsável. Boletins seguem a adaptação própria #654; Relatórios continuam pendentes na FINAL-1.

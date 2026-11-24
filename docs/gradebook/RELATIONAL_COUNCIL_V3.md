# Conselho relacional V3 — contrato #648

Execução FINAL-3 #635. A autoridade desta superfície é
`calculated-eligibility-explicit-human-decision`: o sistema calcula e explica a
elegibilidade a partir do mesmo read model relacional de Desempenho, mas nunca
transforma esse cálculo em deliberação humana. O nome continua valendo como princípio;
o campo `authority` saiu do contrato em 23/11/2026, por não ter leitor.

## Semântica vigente

- contexto único e explícito por pedido: um ano letivo, de 2000 a 9999
  (`academic-year-v2`), já materializado pela Relação;
- decisões pelos códigos 1 (aprovado pelo Conselho), 2 (reprovado pelo Conselho)
  e 3 (reprovado por falta), gravadas em `conselho_decisao`. O Conselho mostra a
  decisão em vigor, a mesma que o cálculo do Desempenho honra: a decisão
  registrada antes de uma nota mudar o caso do aluno deixa de contar, e as duas
  abas nunca divergem. O contrato traz só o código; a tela escreve o rótulo;
- não há contagem de votos no contrato nem no serviço desde 23/11/2026: a função
  está em refação e `conselho_votacao` permanece no banco, sem uso;
- empate e eventual voto de minerva do diretor são resolvidos fora do sistema,
  durante a reunião. Não há identidade, campo, ação ou histórico de desempate;
- só o estado atual é guardado (BN-DEC-049, #1558): a sessão e a decisão de cada
  aluno. Uma informação nova substitui a atual; não há linha do tempo, histórico
  nem fotografia de fechamento;
- quem o Conselho delibera (`relationalCouncilVotableV3`): o aluno elegível pelo
  cálculo e o aluno com recuperação ainda não lançada (`recovery-pending`);
- quem o Conselho só vê, "para conhecimento" (`relationalCouncilInformedV3`): o
  aluno que a planilha já reprova por não comparecer à recuperação (N/C,
  `failed-no-show`) ou pelo regimento (R/R, `failed-repeat`). Não é deliberado e
  não entra nas contagens da turma;
- a reunião de uma turma só abre, sem justificativa; não existem fechar nem
  reabrir. A turma aparece como concluída quando todos os alunos a deliberar têm
  decisão: é um estado derivado, não gravado, e a decisão pode mudar a qualquer
  momento, mesmo depois disso;
- antes de a reunião estar aberta nada pode ser inserido, só visualizado. É a
  regra para as funções de decisão e contagem que serão refeitas; hoje `open` é o
  único comando de escrita;
- turma sem ninguém a deliberar não tem reunião a abrir. A aba lista só as turmas
  que têm alguém para o Conselho, a deliberar ou para conhecimento;
- a elegibilidade é calculada na hora, pelas notas, sem trava no sistema: uma
  nota corrigida que chegue durante o Conselho muda a lista. O controle é
  operacional e fora do sistema (ver a seção de 23/11/2026);
- a lista de turmas traz sempre a contagem de cada turma: aprovados, reprovados
  (pelo Conselho ou por falta) e pendentes entre os alunos a deliberar, e os
  alunos para conhecimento; só fica sem ela a turma que não pôde ser lida;
- `conselho_anterior` não participa da elegibilidade nem da interface ativa. As
  colunas históricas existentes são preservadas fisicamente, sem backfill;
- a rota exige autenticação server-side e a área `desempenho` do Centro
  (`authorizeGradebookRuntimeV1(session, ['desempenho'])`; ADMINISTRADOR tem
  todas as áreas), sempre com `Cache-Control: no-store`.

## Sessão e concorrência

Uma turma começa em `not-opened`. O único comando de escrita é `open`, com
`{ year, classId }`: não leva versão esperada, chave de idempotência nem
justificativa, e o contrato estrito recusa esses campos. Ele insere a linha de
`conselho_sessao` (estado 1, versão 1) com `ON CONFLICT DO NOTHING`; abrir de
novo responde a reunião já aberta, portanto o comando é idempotente e duas
aberturas simultâneas terminam as duas em `ready`. A turma é lida antes de a
linha ser inserida: turma inexistente ou ilegível não ganha sessão. Uma linha com estado 2,
fechada pela versão anterior, é lida como aberta. `open` roda em transação
`SERIALIZABLE`, sob o bloqueio de escritor do reset do ano e com uma nova
tentativa em SQLSTATE 40001; leituras usam `REPEATABLE READ, READ ONLY`.

Abrir registra a escrita para o reset do ano sem mudança acadêmica: a versão de
dados do Portal não muda e a rota não dispara mais o aviso pós-commit ao Portal.
Não há fechamento nem reabertura. "Concluída" não é estado da sessão: a tela a
deriva de `session.state: 'open'` com `summary.pending` igual a zero. Uma decisão
nova substitui a anterior: não há histórico de sessão, decisão ou votação.

Requests, todos estritos: `classes` com `{ year }`; `workspace` e `open` com
`{ year, classId }`. Qualquer outro campo (`offset`, `limit`, `tally`,
justificativa, versão, chave de idempotência) é `invalid-request`. O contrato
segue `contractVersion: 3`.

Resposta de `classes`: `{ year, classes: [{ id, label, tally? }] }`, sem
paginação. `tally` é `{ approved, rejected, pending, forInformation }`, tirado da
própria leitura da turma (`rejected` soma os reprovados pelo Conselho e os por
falta), e falta só na turma que não pôde ser lida. Um ano com mais turmas que o
limite (100) responde `scope-too-large` inteiro; a lista nunca é cortada.

Resposta de `workspace` e de `open`:
`{ context: { year }, classGroup: { id, label }, session: { state }, summary, students }`,
com `session.state` `not-opened | open` e
`summary: { total, decided, pending, approved, rejected, absence, forInformation }`.
`total` conta a turma inteira; `students` traz só quem está diante do Conselho
(a deliberar ou para conhecimento), não a turma toda; `forInformation` conta os
alunos para conhecimento; os demais números contam só os alunos a deliberar. O
contrato recusa a resposta cujo resumo não bate com a lista de alunos, ou que
traga um aluno fora desses dois grupos.

Aluno: `{ id, name, number, eligibility: { eligible, code, failedComponentCount }, decision: { code } | null, components }`.
`eligibility.code` é um de `eligible`, `recovery-pending`, `failed-no-show` e
`failed-repeat`, os quatro casos que chegam ao Conselho; com R/R e N/C no mesmo
aluno vale `failed-repeat`, a ordem do próprio cálculo. Componente:
`{ offerId, subject, terms[3], termRecoveries[3], annual, recovery, result }`:
as notas de cada trimestre, a REC de cada trimestre, o total do ano antes da
recuperação e o total depois dela. Nota: `{ valueMilli, state, level }`, com
`level` `at-or-above | below | not-classified` (alcança ou não o mínimo do ano,
em proporção ao máximo da própria nota), do mesmo cálculo do Desempenho. Limites:
150 alunos e 40 ofertas por turma.

Falhas: `invalid-request`, `not-authorized`, `not-found`, `unavailable` e
`scope-too-large`. HTTP: 200, 400, 404, 422 (`scope-too-large`) e 503; a rota
responde 401 ou 403, sem corpo, a quem não está autenticado ou autorizado, e o
cliente lê isso como `not-authorized`. Não há mais 409.

Saíram do contrato em 23/11/2026:

- `close`, `reopen`, `decision`, `vote`, o campo `vote`, `reviewReference`,
  `session.version`, `sessionVersion`, `currentVersion`, `expectedVersion`,
  `idempotencyKey`, `timeline`, `closures`, `session.closedAt`,
  `session.snapshotCount` e `decision.version`;
- as falhas `version-conflict`, `idempotency-conflict`, `session-not-open`,
  `session-already-open`, `session-closed`, `closure-blocked`, `review-conflict`
  e `student-not-eligible`;
- campos que nenhuma tela lia: `offset`, `limit` e `nextOffset` de `classes`; o
  nome (`name`) e `sessionState` de cada turma da lista; `classGroup.name`,
  `readAt`, `authority`, `context.minimumApprovalMilli` e
  `context.maxCouncilComponents`; `summary.eligible` e `summary.notEligible`; do
  aluno, `statusLabel`, `calculatedResult`, `eligibility.label` e, da decisão,
  `label`, `justification` e `updatedAt`; da nota, `maximumMilli`; do componente,
  o `id` e a abreviação da disciplina (`subject` passou a ser só o nome).

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
gravada. Nenhuma tabela foi alterada por isso. Dos não elegíveis, só voltaram aos cartões, no
mesmo dia, os reprovados por N/C ou R/R na planilha, "para conhecimento" (seção própria, abaixo).

## A reunião só abre — 23/11/2026

Complemento do responsável à BN-DEC-049 (#1558, PR rascunho #1559), no mesmo dia:

- a reunião de uma turma só abre. "Fechar" e "Reabrir" não existem mais; a turma
  aparece como concluída sozinha quando todos os alunos a deliberar têm decisão,
  e a decisão pode mudar a qualquer momento, mesmo depois disso;
- antes de a reunião estar aberta, nada pode ser inserido, só visualizado;
- turma sem ninguém a deliberar não tem reunião a abrir;
- a elegibilidade continua calculada na hora, pelas notas. Se uma nota corrigida
  chegar durante o Conselho, a lista muda. Não há trava no sistema: os alunos
  serão reconferidos antes de a decisão terminar e a escola combinou não enviar
  notas ao sistema nesse período;
- sem histórico, não há como desfazer uma troca de decisão por engano: risco
  aceito pelo responsável;
- divulgação ao aluno: como a decisão vale assim que registrada, haverá
  futuramente um controle interno para mostrar o resultado no Portal a partir de
  uma data. **Não implementado**; só registrado como intenção.

Tela: a linha da reunião mostra o estado (Ainda não iniciada, Aberta ou Concluída)
e o botão "Abrir reunião" só enquanto a reunião não está aberta; ela não aparece
na turma sem ninguém a deliberar. A fila tem até três grupos: "A deliberar",
"Decididos" e "Para conhecimento" (os dois últimos só quando têm alguém). Em tela
larga (a partir de 1101 px) ela é uma lista compacta no canto direito, uma linha
por aluno; em telas menores, faixas acima do cartão. O resumo de quatro números
(alunos, elegíveis, a deliberar, decididos) fica em uma linha também no celular;
"elegíveis" conta quem é deliberado, a soma dos dois números ao lado. Nos botões
de turma, as contagens têm forma além da cor (✓ aprovados, ✕ reprovados,
● pendentes) e há um aviso quando a leitura da turma falhou. As últimas turmas
lidas, com suas contagens, ficam guardadas enquanto o Centro está aberto e
aparecem de imediato ao voltar à aba, sendo substituídas pela leitura seguinte.

As contagens das outras turmas são atualizadas ao entrar na aba e ao voltar a
ela (no máximo uma vez a cada 30 segundos, sem esconder a lista em tela); a turma
aberta se atualiza sozinha. Foi mantido assim porque reler todas as turmas custa
uma leitura inteira por turma: em 23/11/2026, no banco de produção com os dados
de 2025 (medição somente leitura), de 45 a 70 ms só na consulta das notas de cada
turma, fora as demais consultas e o transporte. A #1560 avaliou acelerar essa
consulta e foi encerrada sem mudança.

## Só turmas com elegíveis, em botões independentes — 23/11/2026

Novo complemento do responsável à BN-DEC-049 (#1558, PR rascunho #1559), no
mesmo dia:

- a aba lista somente as turmas que têm alguém para o Conselho. O pedido era
  "só turmas com elegíveis"; no mesmo dia entraram também as turmas com alunos
  para conhecimento (seção seguinte). Turma sem ninguém não aparece e nada a
  marca: saíram o travessão ao lado da turma e o aviso de turma sem elegíveis;
- cada turma é um botão independente (`aria-pressed` na turma aberta); saiu o
  trilho contínuo de abas;
- turma que não pôde ser lida continua listada, com o aviso "Contagem
  indisponível", para não ser tomada por turma sem ninguém;
- ano sem nenhuma turma listada mostra "Nenhuma turma com alunos para o
  Conselho"; com turmas listadas e nenhuma aberta, "Escolha uma turma para abrir
  a pauta".

Leitura: o pedido `classes` traz sempre as contagens (o campo `tally` do pedido
saiu) e é feito ao entrar na aba e ao voltar a ela, sem leitura separada das
contagens. A turma que não pôde ser lida não derruba a lista: vem sem contagem. A
lista fica guardada enquanto o Centro está aberto. Em segundo plano só a turma
aberta é relida; se essa releitura vier sem ninguém para o Conselho (nota
corrigida), a turma sai da lista e é fechada. Falha de leitura mostra "Tentar
novamente", que relê a turma aberta ou, sem turma aberta, as turmas.

Nenhuma migration nova. `conselho_idempotencia` e `conselho_votacao` ficam sem
uso pelo código e `conselho_decisao` é só lida; as três entram na lista do que
revisar com o responsável antes de integrar, junto com a `0023`.

## Para conhecimento e recuperação em branco — 23/11/2026

Complementos do responsável à BN-DEC-049 (#1558, PR rascunho #1559), no mesmo
dia:

- **para conhecimento.** O aluno que a planilha já reprova por não comparecer à
  recuperação (N/C) ou pelo regimento (R/R) aparece nos cartões, num grupo "Para
  conhecimento", sem voto e fora das contagens da turma: o Conselho precisa ver
  as notas dele para confirmar a situação. A turma que só tem alunos assim
  aparece na lista, sem contagem no botão e sem "Abrir reunião";
- **recuperação em branco.** O aluno com recuperação ainda não lançada é
  deliberado: entra na fila "A deliberar" e nas contagens da turma, com a
  situação "Recuperação pendente", porque nem sempre é possível lançar na
  planilha que ele não compareceu. Só o N/C já lançado fica para conhecimento.

No contrato, as duas regras têm nome: `relationalCouncilVotableV3` (elegível ou
`recovery-pending`) e `relationalCouncilInformedV3` (`failed-no-show` ou
`failed-repeat`). `summary.forInformation` e `tally.forInformation` contam os
alunos para conhecimento; `decided`, `pending`, `approved`, `rejected` e
`absence` contam só quem é deliberado. Um aluno para conhecimento fica nesse
grupo mesmo que exista uma decisão antiga gravada para ele. Os demais não
elegíveis (aprovado, em curso, situação de matrícula, acima do limite de
componentes, definições incompletas) não são enviados: contam só em
`summary.total`.

A regra de cálculo não mudou: R/R e N/C continuam reprovação pela planilha, e a
elegibilidade vem do mesmo read model do Desempenho.

## Cartão do aluno — 23/11/2026

Pedidos do responsável no mesmo dia (#1558), em várias iterações no preview:

- o aluno em pauta é o cartão da frente de uma pilha, num palco ao centro; os
  anteriores da fila ficam atrás, à esquerda, e os próximos, à direita (até dois
  de cada lado). Uma seta de cada lado ("Aluno anterior", "Próximo aluno") e, sob
  a pilha, um ponto por aluno da fila, na cor do grupo dele, levam de um aluno a
  outro. Só o cartão da frente é lido e alcançável;
- a ordem da pilha é a da fila: a deliberar, decididos, para conhecimento;
- o cartão traz a foto, o nome, o número e a situação de fim de ano num selo:
  "Reprovado" até o Conselho decidir, depois a decisão ("Aprovado pelo Conselho",
  "Reprovado pelo Conselho", "Reprovado por falta"). Sob o selo vai o motivo,
  quando há: "Não compareceu" (N/C) ou "Pelo regimento" (R/R). A recuperação em
  branco mostra "Recuperação pendente". Não aparecem "Em curso", transferência
  nem a etiqueta "Elegível";
- a tabela segue o boletim da escola: os componentes em colunas; em linhas, a
  nota e a REC de cada trimestre; ao pé, a nota final. As notas sempre têm
  decimal (18,0); N/C e R/R aparecem escritos;
- cada nota tem fundo próprio: azul quando alcança o mínimo, vermelho quando
  fica abaixo (`level`). A coluna do componente não aprovado fica destacada. A
  REC que o aluno deve e a planilha ainda não trouxe tem uma marca amarela, sem
  número;
- a nota final é o total com a recuperação só quando ela está completa; até lá,
  e quando o aluno não a fez, é o total das notas como estão.

## Revisão do código — 23/11/2026

Correções de uma revisão independente, sem mudança de regra:

- leitura: a lista de turmas é relida ao voltar à aba; a leitura interrompida
  não deixa a tela em "Carregando…"; a lista e a turma aberta têm cada uma a sua
  marca de dado antigo; o aviso de falha some quando a leitura seguinte dá certo;
  a resposta de "Abrir reunião" é ignorada se a turma aberta já é outra; ano
  ainda não definido não mostra carregamento;
- serviço: os itens acima sobre a decisão em vigor, a ordem R/R antes de N/C, a
  leitura antes da abertura e o envio só de quem está diante do Conselho;
- acessibilidade: a tabela do cartão diz "(abaixo do mínimo)" e "(não aprovado)"
  a quem usa leitor de tela, a marca amarela tem nome ("Recuperação ainda não
  lançada"), a seta sem destino fica desabilitada e os pontos sob a pilha saem
  da leitura e do teclado, porque repetem a fila.

Ficou como está, para decidir com o responsável: o aluno com N/C em um
componente e recuperação em branco em outro é lido como "Recuperação pendente"
(segue o cálculo) e vai a voto; `summary.total` ("alunos") conta a turma inteira
da Relação, inclusive transferidos e desistentes; depois de "Abrir reunião" o
foco do teclado não é reposicionado.

## Votos futuros — decisão de 23/11/2026, não implementada

Para a etapa dos botões de decisão, o responsável definiu que, além de aprovado e
reprovado pelo Conselho, haverá:

- "Reprovado por falta": faltas às aulas, a terceira decisão que já existia
  (código 3);
- "Não compareceu": para a recuperação em branco;
- "Reprovado pelo regimento": o R/R.

Os dois últimos valem "como se nós tivéssemos informando isso na planilha, mas
sem digitar nela", e só para os casos em que a planilha não traz a informação.

Consequência técnica analisada, ainda **não decidida nem implementada**: a regra
de cálculo não muda; a informação dada pelo Conselho precisa de registro próprio,
porque a importação regrava `gradebook.fechamento`, e precisa ser lida onde a
recuperação entra no cálculo (read model do Banco e leitura do Portal), valendo a
planilha quando ela estiver preenchida.

## Preview local

Só o preview do admin usa: `build/adm-preview-gradebook-v1.ts` guarda o banco
PGlite em disco, em `node_modules/.cache/adm-preview-gradebook` (pasta ignorada
pelo git; mudar uma migration ou o seed recomeça dos dados inventados), e
`src/adm-preview/main.tsx` lembra no navegador o ano letivo em uso. Em produção
o ano continua só em memória.

## Antes de integrar

Pendências registradas em 23/11/2026. Por pedido do responsável, durante as
iterações fez-se só o necessário; documentação, testes antigos e limpeza ficaram
para antes do merge. Nada foi publicado e a produção não foi alterada.

- rever com o responsável as tabelas e o código sem uso: as seis tabelas e a
  coluna que a `0023` remove, `conselho_idempotencia`, `conselho_votacao` e, em
  `conselho_sessao`, a coluna `versao` e o estado 2;
- aplicar a `0023` só depois de publicar o código e com o aval dele;
- `npm run verify` e CI no head final.

## Limites do aceite

Testes PGlite/HTTP/React cobrem contrato, grants, abertura da reunião (inclusive
repetida), contagens por turma, autorização e estados da interface. Eles não
substituem restauração institucional, ensaio de contenção PostgreSQL
multi-sessão, aceite acadêmico #347 nem a validação visual única com o
responsável. Boletins seguem a adaptação própria #654; Relatórios continuam pendentes na FINAL-1.

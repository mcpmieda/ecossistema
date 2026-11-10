# Operação administrativa — #756 / entrega N

Base: d3def6972808d2fec49e6011ec0f0de823f7db5e (QR/PDF #755 publicado).
Identidade CHAT ONLINE preservada. Autoria e execução direta nesta sessão, uma issue por vez.
Montagem de navegação e serviços produtivos: #757; QA integrada: #758; aceite legítimo: #759.

## Escopo e contrato

A extensão de ownership foi registrada antes de editar na #756, comentário 5656480647,
e incorporada ao corpo da issue; mãe #742 comentário 5656480856.
Além das seis pastas originais sessions/audit/overview e seus testes, somente:
shared/student-portal-contracts/admin-read-v2.ts,
server/student-portal/admin/{queries-v2,account-read-context-v2,sessions-read-v2}.ts,
tests/student-portal/contracts/admin-read-v2.test.ts e
tests/student-portal/admin/{read-cases-v2,sessions-cases-v2}.ts.

V1 e todos os comandos permanecem intactos. Sem novo endpoint, DDL, ACL, segredo,
dependência, escrita acadêmica ou alteração de população/acesso produtivo.
A leitura opt-in sessions-read V2 preenche lacuna real: o expiresAt armazenado de V1
não informa se a política vigente reduziu o prazo ou impediu o acesso.

A resolução de conta/vínculo/política de accounts-read/overview foi extraída para
account-read-context-v2 e reutilizada. Nenhuma regra acadêmica foi recriada.
A leitura de sessões usa a transação READ ONLY/REPEATABLE READ já existente,
relógio PostgreSQL, página até 100, lote de até 100 contas distintas e número fixo
de queries (teste <=7, inclusive início/relógio/versão).
Cursor existente assina operação, contrato, ator, filtros/escopo e expira em 5min;
não se alega assinatura da versão da fonte.

O DTO informa scope, observedAt, versão própria de revogação, revocableCount,
sessionId/accountId, nome/turma/classId, accountVersion, createdAt,
expiresAt/effectiveExpiresAt, revokedAt, persistent e validade:
revogada prevalece; prazo efetivo vencido é expirada; demais impedimentos são
acesso indisponível; válida exige política, elegibilidade, estado ativo,
securityVersion e criação não futura. Não retorna token, hash ou segredo.
O prazo efetivo respeita vencimento armazenado, fim do ano e duração atual
curta/persistente desde createdAt. O estado é rotulado como observado na consulta,
sem contador local inventando validade.

A seleção de turma corresponde ao serviço real de revogação: qualquer vínculo
corrente não-status6, incluindo ambiguidade. Ambiguidade não concede acesso.
Ação de turma inclui esses registros; ações por linha dentro de uma turma exigem
classId atual resolvido. Mudança de turma durante preparação recusa o alvo antigo.
Escola pode consultar; não há botão de revogação escolar.

## Composição das telas

StudentSessionsV1, StudentAuditV1 e StudentOverviewV1 recebem OperationsPropsV1:
client V1, reader V2, scope, identityKey e canWrite obrigatórios;
scopeLabel, catálogo completo de turmas e onAuthorizationLost opcionais.
Fornecer clients estáveis e identidade/capacidade da sessão Entra vigente.
Sem props de role/contexto confiável vindo do browser. A API continua decidindo
autorização e require platform.settings.write para comando/detalhe bruto.

OperationsScopeV1 só repassa o escopo escolhido nas abas do Painel do Aluno
(o seletor próprio de turma e aluno foi removido em 10/11/2026: nunca aparecia).
A Visão geral lê a escola e mostra todas as turmas numa só consulta. Troca de
escopo/identidade/capacidade desmonta o estado. 401/403 em consultas de negócio,
catálogo, comando ou detalhe elimina contexto protegido e notifica a integração.
Nenhum cache/storage, exportação de auditoria, QR, nascimento ou senha nestas telas.

Sessões: início/tipo/prazo/estado, três ações distintas, conferência fresca antes
da revisão. Revogação individual e conta usam CAS da conta; turma usa revisão
anual conservadora do serviço. Contagem na revisão é observada, não lock de novas
sessões. Texto explica abrangência no commit e possibilidade de novo login.
Cancelar/Escape tem foco inicial em Cancelar e devolve foco sem comando.
Após resposta committed, descarta leitura anterior e consulta de novo; sem remoção
otimista, nem retorno tardio restaurando linha. Erro incerto retém somente bytes
preparados/CAS/idempotência; repetir não cria outra intenção. Retry-After respeitado,
409 pede consulta/revisão nova, 401/403 encerra contexto. Recibo UI limita retomada
a 23h diante da retenção backend24h. Cleanup aborta e permite StrictMode reutilizável.
Não afirma logout ao fechar navegador nem altera senha/QR.

Auditoria: intervalo inclusivo São Paulo usando calendarInstantV1 existente,
evento/resultado e escopo turma/conta; filtros só aplicam depois de validar.
Cursor preserva filtro. Lista só tem IP mascarado. Detalhe autorizado faz duas
consultas delimitadas em paralelo: audit-detail V1 e accounts-read V2 limit1 para
relógio do servidor. Sem relógio, falha fechada. Tempo monotônico desde início do
request reduz conservadoramente o prazo restante; IP é removido no menor limite
entre ipExpiresAt e evento+90d. Metadados são descartados até evento+12 meses,
incluindo clamp de ano bissexto, e detalhe inteiro fica no máximo5min.
Fechar, navegar, trocar identidade/capacidade ou resposta tardia não restauram IP.
Retry-After persiste ao fechar/reabrir o detalhe. IP de fixture192.0.2.42 é reservado
para documentação; nenhuma evidência usa IP de pessoa.

Visão geral: resumo V2 e health V1 separados, permitindo observar saúde mesmo
quando a consulta de negócio falha. normal/attention/intervention têm tradução.
Totais indisponíveis não viram zeros; categorias se sobrepõem e não são somadas
nem convertidas em porcentagens. Rate limit falha a consulta e respeita espera.
Sem gráfico decorativo, métricas fictícias, card de importação abolida ou detalhes
técnicos não contratados.

## Evidência e limites

Testes de contrato, PGlite e PostgreSQL nativo compartilham sessions-cases-v2:
105 sessões, bounded queries, sem secrets, prazo/política/segurança/bloqueio,
vínculo ambíguo, cursor/ator/escopo, leitura vs escrita, CAS, revogação individual,
conta e turma, replay do recibo. A suíte PostgreSQL oficial é gate de CI/release,
não se presume PASS antes de executá-la.

Testes UI/controller: três escopos/CAS, confirmação/Escape/foco, 105 páginas,
read-only, 401, pagehide, intervalo/filtros/cursor, IP mascarado/detalhe/capacidade,
deadline90d/12m, relógio ausente, elapsed monotônico, respostas tardias, Retry-After,
23h de recibo, StrictMode, seleção por ID/identidade e saúde degradada.
Contagens e SHA final constam no PR e no handoff após verify/CI, sem antecipar PASS.

QA sintético compilado pelo Vite, servido localmente com CSP exata ADM.
Browser Act bloqueado pela política Windows já diagnosticada; CUA usada sem
contornar a proteção. Desktop1280×850 doc/client1265; mobile390×740 doc/client375,
tabela780 dentro de viewport293. Diálogo320×700 com273px, rodapé ajustado pelos
data-slot reais HeroUI: botões completos empilhados. O mínimo global320px do ADM
continua reservado à #757; isso não é homologação integral de320px.
Sessões105→página2 com5; revogação individual da página2 confirmou e recarregou
79→78 sem revogação. Resposta perdida em turma:2 chamadas,1 intenção, só então
confirmação+nova consulta0. Auditoria mostrou IP sintético no detalhe e o removeu
após prazo; Select de evento e estado vazio passaram. Resumo/saúde e falha parcial
inspecionados. Console final sem warnings/errors. Aba temporária fechada,
viewport restaurado e helpers encerrados.

Limitação: o método setValue do IAB rejeitou o valor de datetime-local. Entrada
nativa completa por teclado/date-picker não foi estabelecida; não se atribui
defeito ao produto por esse erro da ferramenta. Conversão e aplicação dos filtros
passaram nos testes DOM; #758/#759 devem fechar a prova nativa com o ambiente
de uso. Sem login Entra, revogação estudantil real, raw IP real ou escrita
produtiva nesta entrega. G-B permanece PARCIAL. Deploy não abre acesso.

## Delta para o integrador #757

Montar as três telas nos slots/navegação existentes com props reais e clients
estáveis; incluir a extensão sessions-read na documentação central, distinguindo
V1 bruto de V2 efetivo e contagem observada de escopo no commit.
Revalidar sessão/capacidade ao retomar, limpar a aplicação no callback401/403.
Corrigir mínimo global320px do ADM. QA autenticada de revogação deve mostrar a
negação da sessão na próxima leitura real; teste visual sintético não a substitui.
Publicar backend compatível antes dos consumidores pelo workflow oficial.
Rollback somente de código compatível, preservando dados, chaves e revogações.

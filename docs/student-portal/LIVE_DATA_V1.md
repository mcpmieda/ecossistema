# Sincronização automática e confirmação rápida V1 (#808)

## Três mecanismos, três alcances

1. **Recuperação periódica:** leitores autorizados revalidam a cada 30 segundos, com pausa em aba oculta ou offline, respeito a `Retry-After`, uma consulta por leitor e coalescimento de invalidações. É recuperação e não recebe o nome de tempo real.
2. **Aviso local:** `BroadcastChannel` envia somente `{type: "invalidate", domain}` entre abas da mesma origem. Não carrega dados acadêmicos, credenciais ou rascunhos, não usa storage persistente e não atravessa dispositivos.
3. **Push remoto:** WebSockets autenticados chegam ao Durable Object via Worker. O navegador recebe somente domínio, cursor, versão opaca e instante. O aviso dispara uma nova leitura autorizada; notas, nascimento, QR, senha, escopo interno e identificadores de roteamento nunca são enviados no socket.

Polling permanece como recuperação explícita se o push estiver indisponível. Não há promessa de tempo real entre dispositivos baseada apenas no temporizador ou no `BroadcastChannel`.

**ADM desde 03/11/2026 (`ADMIN_AUTOMATIC_READS_V1 = false` em `src/App.tsx`):** o Painel do Aluno e o Banco de Notas não usam mais a recuperação periódica nem o push remoto; o ADM não abre WebSocket. A tela relê quando a janela volta, depois de cada escrita do próprio administrador e no F5 (área, turma, turno e ficha ficam no endereço). Essa releitura é silenciosa (`silent` em `createLatestPortalRequestV1`): não mostra "carregando", não desabilita controles, mantém a tela com o aviso de sincronização numa falha passageira e só redesenha quando a resposta muda. As escritas continuam conferindo versão (`expectedVersion`), e a publicação mantém seu acompanhamento próprio. O motivo foi a tela piscando a cada volta da janela e o custo de leituras sem uso para poucos administradores.

## Durabilidade, autorização e retomada

`0011_live_event_outbox_v1.sql` deriva eventos mínimos, na mesma transação, de `revision_event` e dos eventos Portal confirmados em `audit_event`. Uma importação produz o evento de revisão agrupado já existente, não uma fila por aluno. O dispatcher reivindica lotes com lease/`SKIP LOCKED`, publica fora da transação PostgreSQL e marca entrega ou agenda retry exponencial. Uma execução agendada por minuto recupera falhas e gravações feitas fora do Worker do Portal.

Há um Durable Object SQLite por audiência/ano. Ele preserva o maior cursor e usa WebSocket hibernável com attachment de autorização derivado pelo servidor. Ao retomar com cursor anterior, o cliente recebe um pedido genérico de ressincronização dos dois domínios e refaz as leituras autorizadas. O ADM e o aluno usam handshakes distintos; contexto ADM vem da sessão Entra selada e a identidade do aluno vem da sessão Portal lida no PostgreSQL. Nenhum navegador mantém conexão PostgreSQL.

Expiração ou negação limpa conteúdo protegido pelo leitor proprietário. Sockets expirados são encerrados na próxima interação/evento, e eventos de revogação provocam revalidação do `/me`. O navegador não escolhe tenant, capacidade, conta, aluno ou turma.

## Preservação de interface

Leituras do mesmo contexto atualizam dados sem remontar por `readAt`: seleção, filtros, paginação, detalhe aberto, foco e rolagem permanecem. Mudança real de ano, turma, conta ou autorização invalida o conteúdo anterior. Respostas antigas são canceladas/ignoradas.

Conselho, configurações e demais editores suspendem a aplicação de leituras enquanto houver valor digitado, revisão sensível ou comando em curso. O conflito é local e mantém o rascunho. Em Boletins, somente a prévia acompanha a fonte; emissão e reimpressão continuam usando o snapshot imutável.

## Confirmação rápida de nascimento

O comando `birth-write` aceita `includeSavedBirth: true`. Servidores compatíveis podem devolver, depois do commit, apenas `accountId`, `classId`, `accountVersion`, `version`, `year` e `confirmation`, lidos dentro da transação. A ausência do campo preserva clientes antigos e aciona uma única leitura de reconciliação, nunca outra gravação. Replay após mudança posterior omite snapshot superado.

O editor só aplica a confirmação quando conta/versões correspondem e não substitui um rascunho mais novo. `unconfirmed-test` continua explícito e nunca vira confirmação institucional automaticamente.

## Origem recuperada e autoria desta entrega

Da árvore candidata `07cf7bce2026fb0cde341f1a216b31d31aae2236` foram recuperados seletivamente: contrato/serviço de confirmação de nascimento, consumo no editor, cancelamento de leitura preservando conteúdo, aviso de leitura desatualizada, controlador de publicação, reconexão do Portal, adaptação da visão geral e teste PostgreSQL inicial. O acesso ao mapa do editor foi corrigido para `record.account.accountId` após conferência dos tipos.

Foram implementados nesta branch: consumidores restantes e proteção de rascunhos, outbox transacional, dispatcher recuperável, Durable Object hibernável, handshakes ADM/aluno, cliente WebSocket com retomada/offline, testes de segurança/rollback/idempotência/workerd e ensaio local de fan-out. A árvore candidata não foi aplicada inteira.

## Limite da evidência de carga

A prova workerd abre aproximadamente 600 sockets no mesmo objeto e exige que um aviso agrupado chegue a todos sem nova consulta PostgreSQL por socket. Isso mede o runtime local e detecta regressão de fan-out; não homologa 600 usuários simultâneos em produção. Capacidade produtiva depende de métricas reais de conexão, latência, erro, backlog/retry do outbox, CPU e limites da conta Cloudflare.

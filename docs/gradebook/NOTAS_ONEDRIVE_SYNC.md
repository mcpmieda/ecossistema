# Leitura automática das planilhas de notas (OneDrive)

O Worker `notas-onedrive-sync` lê as planilhas de notas dos professores na pasta do OneDrive da secretaria e lança só o que mudou, alguns segundos depois do salvamento. Usa o mesmo leitor, a mesma Auditoria e a mesma importação autoritativa do botão de importação.

## Como funciona

1. A Graph avisa (webhook) que algo mudou no OneDrive; a consulta *delta* diz quais arquivos da pasta mudaram.
2. Cada arquivo tem uma leitura por vez. Um salvamento durante a leitura faz o arquivo ser relido logo depois. Arquivo com o mesmo *hash* da última leitura é pulado sem download.
3. A leitura grava primeiro a Auditoria e depois as notas. Pelo bloqueio parcial (BN-DEC-045), um problema segura só a nota, o resultado ou a turma afetada; o resto é lançado.
4. Depois de gravar, o Portal recebe o aviso ao vivo; a publicação continua sendo decidida na tela de publicação.
5. Rede de segurança: *delta* de hora em hora (a cada minuto se o webhook não estiver ativo) e conferência completa da pasta às 03:00.
6. Disjuntor: 5 falhas seguidas pausam a leitura por 15 minutos.

Apagar um arquivo da pasta **não apaga notas**: o arquivo só fica marcado como removido.

## Estado

O estado operacional (configuração, status por arquivo, posição do *delta*, assinatura do webhook, disjuntor e registro de alterações) fica no armazenamento SQLite do Durable Object `NotasSyncCoordinatorV1`. Notas e Auditoria ficam no PostgreSQL, como hoje. Não há migration de banco.

## Operação

O Worker começa **desligado**. Toda a operação fica no Centro de Administração, em **Banco de notas › Importação › OneDrive**, só para administradores:

1. **Escolher a pasta do ano letivo:** navegar no OneDrive da secretaria, ver a prévia (quantas planilhas, uma leitura de teste sem gravar e o teste do aviso da Graph) e confirmar. A pasta é guardada pelo ID da Graph, então renomeá-la não quebra nada. A pasta escolhida por último é a lida.
2. **Ligar, desligar, pausar, retomar e "Conferir tudo agora".**
3. **Ajustes:** espera depois do salvamento (padrão 0 s) e arquivos em paralelo (padrão 6).
4. **Planilhas:** situação de cada arquivo, horários, tempo de leitura, tempo do salvamento ao lançamento e "Ler de novo".
5. **Histórico de alterações:** quem mudou o quê e quando.

O Pages confere a sessão de administrador e chama o Worker pela ligação `NOTAS_SYNC_SERVICE` (entrada `NotasSyncAdminV1`). O Worker não tem nenhuma rota pública de operação; a única rota pública recebe os avisos da Graph.

Ao ligar pela primeira vez, ou depois de trocar a pasta, todas as planilhas da pasta são lidas e lançadas uma vez (como uma importação completa).

## Segredos

`GRAPH_CREDENTIAL_A`/`B` são gravados pelo `entra-maintenance.yml` ao rotacionar a Graph. `NOTAS_SYNC_CLIENT_STATE` é um valor aleatório definido uma vez no Worker. `NOTAS_SYNC_WRITE_TOKEN` é um valor aleatório definido no Worker e no Pages (veja Gravação pelo Pages). O Worker é publicado pelo `deploy-cloudflare-pages.yml`.

## Privacidade

Logs e respostas de status têm só contagens, tempos, códigos e nomes de arquivo; nunca nomes de alunos ou notas.

## Velocidade (13/11/2026)

Medido em produção: uma leitura gastava 11–15 s, sendo mais de 70% no banco (Auditoria ~3,5 s, gravação ~6,5 s).

- **Memória da última gravação:** o coordenador guarda, por planilha, uma impressão digital da Auditoria e de cada turma/disciplina gravada. A Auditoria só é regravada se mudou, e só as turmas/disciplinas que mudaram são enviadas (no V9, uma oferta fora do pedido fica como está). Sem mudança, o banco nem é tocado. "Ler agora" e a conferência noturna apagam a memória: a próxima leitura grava tudo.
- **Relação em paralelo:** a conexão e a consulta da Relação começam junto com o download.
- **Gravações em fila:** a Auditoria usa um bloqueio por ano no banco. Pelo Hyperdrive, o tempo de espera pedido na conexão não vale, então a gravação que encontra o bloqueio ocupado (`55P03`, `40P01`, `40001`) é repetida até 6 vezes com espera crescente. Cada gravação é uma transação inteira, então repetir é seguro.
- **Distância do banco:** o banco fica em São Paulo. O leitor roda onde o coordenador está: o primeiro coordenador nasceu em San José (EUA); o atual (`notas-onedrive-sync-sam`, `locationHint: "sam"`) ficou em Miami. Fixar a região do worker (`placement targeted`) não valeu nem por RPC nem por `SELF.fetch` (medido em 13/11/2026). O primeiro coordenador (`notas-onedrive-sync`) se apaga sozinho ao acordar; a constante que o reconhece pode sair depois que ele sumir.
- **Testado sem ganho (desfeito):** comandos sem nome no banco (`prepare: false`) e região fixa do worker.
- **Desligado ou pausado:** arquivos pendentes não acordam mais o coordenador.
- O log `notas-sync-stages` mostra o tempo de cada etapa.

## Teste real e fila de gravação (14/11/2026)

Teste com planilhas reais (restauradas no fim, banco conferido igual ao de antes):

- **Excel do computador:** 28–48 s do salvamento ao banco; ~33–36 s disso é o envio do OneDrive e o aviso da Microsoft.
- **Excel online:** 25 s a 2,7 min; o Excel online demora a gravar o que foi digitado no arquivo. Abrir sem editar gera uma leitura que não grava nada (memória).
- **Massivo:** gravações simultâneas disputavam o bloqueio do ano no banco (15–68 s) e algumas esgotavam as tentativas.

Mudanças:

- **Fila de gravação no coordenador:** as leituras correm em paralelo; cada uma pede a vez (`beginWrite`/`endWrite`) antes de gravar Auditoria e notas. Vez não devolvida em 2 min é retomada. A repetição em `55P03` continua como reserva (a importação manual também grava).
- **O coordenador não fica preso esperando um lote:** enquanto as leituras rodam, ele olha o aviso da Microsoft a cada 2 s e dispara novas leituras.
- **Consulta direta a cada 10 s** das 06:00 às 23:00 (São Paulo), sem esperar o aviso da Microsoft.
- O log `gradebook_import_performance` (`source: notas-sync`) mostra só números da gravação (comandos, linhas, milissegundos).

## Gravação pelo Pages

O Worker fica longe do banco (~250 ms por consulta). O Pages, com posicionamento inteligente, fica perto (~20–70 ms). Por isso a leitura baixa e lê a planilha no Worker e manda a metade do banco (Relação, Auditoria, notas) para `POST /api/gradebook/onedrive-sync/gravar` no Pages, com o segredo `NOTAS_SYNC_WRITE_TOKEN`. A fila de gravação continua no coordenador. Se o Pages não responder, faltar o segredo ou der erro, o Worker grava sozinho como antes. Os registros `notas-sync-remote-write` (Worker) e `gradebook_import_performance` com origem `notas-sync-pages` mostram os tempos.

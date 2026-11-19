# Leitura automática das planilhas de notas (OneDrive)

O Worker `notas-onedrive-sync` lê as planilhas de notas dos professores na pasta do OneDrive da secretaria e lança só o que mudou, alguns segundos depois do salvamento. Usa o mesmo leitor, a mesma Auditoria e a mesma importação autoritativa do botão de importação.

## Como funciona

1. A Graph avisa (webhook) que algo mudou no OneDrive; a consulta *delta* diz quais arquivos da pasta mudaram.
2. Cada arquivo tem uma leitura por vez. Um salvamento durante a leitura faz o arquivo ser relido logo depois. Arquivo com o mesmo *hash* da última leitura é pulado sem download.
3. A leitura grava primeiro a Auditoria (com a origem `onedrive:<id do item>`, para não apagar a de outra planilha de mesmo nome; #1462) e depois as notas. Pelo bloqueio parcial (BN-DEC-045), um problema segura só a nota, o resultado ou a turma afetada; o resto é lançado.
4. Depois de gravar, o Portal recebe o aviso ao vivo; a publicação continua sendo decidida na tela de publicação.
5. Rede de segurança: *delta* de hora em hora (a cada minuto se o webhook não estiver ativo) e conferência completa da pasta às 03:00.
6. Disjuntor: 5 leituras de planilha com falha seguidas pausam a leitura por 15 minutos. Erro ao listar o OneDrive só espera 1 min (ou o `Retry-After`) e não conta para o disjuntor; uma leitura que desiste de esperar a vez de gravar (`WRITE-QUEUE-DEADLINE`) também não conta.
7. Cursor do delta recusado pela Microsoft (410) ou antigo demais: a leitura volta a listar as fontes a partir do cursor atual (`delta-resync`). Religar a leitura também começa do cursor atual.
8. A Relação só é gravada quando vem de uma fonte de arquivo único; uma Relação dentro de uma pasta de planilhas fica `ignored` com `RELATION-OUTSIDE-SOURCE`.

Apagar um arquivo da pasta **não apaga notas**: o arquivo só fica marcado como removido.

## Estado

O estado operacional (configuração, status por arquivo, posição do *delta*, assinatura do webhook, disjuntor e registro de alterações) fica no armazenamento SQLite do Durable Object `NotasSyncCoordinatorV1`. Notas e Auditoria ficam no PostgreSQL, como hoje. Não há migration de banco.

## Operação

O Worker começa **desligado**. Toda a operação fica no Centro de Administração, em **Banco de notas › Importação › OneDrive**, só para administradores:

1. **Fontes de leitura:** "Adicionar fonte" navega no OneDrive da secretaria e escolhe uma pasta inteira (com prévia: quantas planilhas, uma leitura de teste sem gravar e o teste do aviso da Graph) ou um arquivo só, como a Relação. Cada fonte fica ligada a um ano letivo e é guardada pelo ID da Graph (renomear não quebra nada). Todas as fontes são lidas do mesmo jeito; para um ano parar de ser lido, remova as fontes dele. Remover uma fonte não apaga notas.
2. **Ligar, desligar, pausar, retomar e "Conferir tudo agora".**
3. **Ajustes:** espera depois do salvamento (padrão 0 s) e arquivos em paralelo (padrão 6).
4. **Planilhas:** situação de cada arquivo, horários, tempo de leitura, tempo do salvamento ao lançamento e "Ler de novo".
5. **Histórico de alterações:** quem mudou o quê e quando.

O Pages confere a sessão de administrador e chama o Worker pela ligação `NOTAS_SYNC_SERVICE` (entrada `NotasSyncAdminV1`). O Worker não tem nenhuma rota pública de operação; a única rota pública recebe os avisos da Graph.

Ao ligar pela primeira vez, ou depois de trocar a pasta, todas as planilhas da pasta são lidas e lançadas uma vez (como uma importação completa).

## Segredos

`GRAPH_CREDENTIAL_A`/`B` são gravados pelo `entra-maintenance.yml` ao rotacionar a Graph. `NOTAS_SYNC_CLIENT_STATE` é um valor aleatório definido uma vez no Worker. `NOTAS_SYNC_READ_TOKEN` é um valor aleatório definido uma vez no Worker (veja Leitura perto do banco). O Worker é publicado pelo `deploy-cloudflare-pages.yml`.

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
- **Consulta direta a cada 10 s** em dia letivo, de 30 min antes da primeira aula até 1 h depois da última (calendário e sinais do Portal, fuso America/Bahia; sem resposta do Portal, seg–sex 07:00–18:00), sem esperar o aviso da Microsoft.
- O log `gradebook_import_performance` (`source: notas-sync`) mostra só números da gravação (comandos, linhas, milissegundos).

## Leitura perto do banco (14/11/2026)

O banco fica em São Paulo. O coordenador (Durable Object) ficou em Miami, e uma leitura chamada por ele (`SELF`) também rodava lá: ~250 ms por consulta. Gravar pelo Pages não resolveu: chamado do Worker, o Pages também rodou em Miami (gravação 3,8 s em vez de 4,4 s).

O que resolveu: o Worker tem posicionamento por região (`aws:sa-east-1`), que vale só para pedidos HTTP. O coordenador pede cada leitura pelo endereço público do próprio Worker (`POST /ler`, segredo `NOTAS_SYNC_READ_TOKEN`), e essa leitura roda em São Paulo (provado com um Worker de teste: chamado de Miami, rodou em GRU, `cf-placement: remote-GRU`). O flag `global_fetch_strictly_public` permite o Worker chamar o próprio endereço. Se `/ler` recusar antes de ler (401/404/405), o coordenador lê pelo `SELF` como antes.

O Portal do aluno aproveita o mesmo caminho para o trabalho de cada minuto (limpezas, eventos ao vivo, histórico e sinais). O endereço público do Portal passa pelo edge do aluno (com checagem de origem), então quem pede é este Worker: o cron daqui chama `POST /portal-agendado` no próprio endereço (mesmo segredo), que roda em São Paulo e aciona o Portal pela ligação `PORTAL_SCHEDULER` (entrada `PortalSchedulerEntrypoint`). Com `PORTAL_SCHEDULER=notas-onedrive-sync` nas variáveis do Portal, o cron do próprio Portal descansa; tirar essa variável devolve o trabalho a ele. Se o endereço recusar antes de trabalhar, o cron daqui aciona o Portal direto (longe do banco, como antes).

## Relação pela leitura automática (14/11/2026)

A Relação do ano (por exemplo `ADMINISTRATIVO/LINHA DO TEMPO/2026/RELAÇÃO 2026.xlsb`) entra como fonte de um arquivo só. Ela é gravada pela mesma importação canônica da importação manual, que só adiciona e atualiza alunos, nunca tira; o salvamento seguinte traz o que vier de novo.

- **Troca de turma clara:** passa direto, mesmo várias no mesmo dia.
- **Troca com dúvida** (o banco não consegue ligar saída e entrada sozinho, ou há sinal de outro aluno na posição): aquela Relação não é lançada e vira um achado `class-move-review` ("Troca de turma a conferir") na **Auditoria**, um por troca. A confirmação é a da importação manual da Relação. A aba OneDrive só recebe dados; nada é confirmado nela.
- **Relação mudou:** as planilhas dos professores do mesmo ano são lidas de novo, inteiras, para entrar a nota de aluno novo que antes ficou de fora.
- Relação igual à última gravada não toca o banco (memória por arquivo).

## Coordenador sempre no código novo (14/11/2026)

Uma publicação nem sempre reinicia o Durable Object coordenador: em 14/11 ele ficou na versão anterior até a publicação ser refeita. Agora o Worker tem a ligação `CF_VERSION_METADATA`, e o cron de cada minuto manda ao coordenador a versão do próprio código. Se o cron já roda uma publicação **mais nova** (pela data da versão) e nada está sendo lido ou gravado, o coordenador chama `ctx.abort()` e volta no código novo na chamada seguinte. Um cron mais antigo nunca reinicia um coordenador mais novo, então não há laço durante a troca de versão. O registro `notas-sync-coordinator-restart` mostra quando isso acontece.

## Vínculos entre planilhas (19/11/2026, #1541)

O Worker também mantém em dia os vínculos entre planilhas do OneDrive da secretaria: Relação e simulados → planilhas dos professores. Faz o mesmo que o "Atualizar vínculos" do Excel com as origens fechadas:

- regrava só a cópia das células da origem que o Excel guarda em cada vínculo (`xl/externalLinks/externalLinkN.bin` ou `.xml`), com os valores salvos na origem;
- marca "recalcular tudo ao abrir" (BrtCalcProp `recalcID=0` + `fFullCalcOnLoad`; no `.xlsx`, `calcPr fullCalcOnLoad="1"`).

Fórmulas, macros, proteção, formato e o resto do pacote não mudam. As partes do ZIP que não mudam são copiadas byte a byte.

**Quando.**
- Uma origem salva (conteúdo novo, não a própria gravação do Worker) agenda as planilhas que dependem dela para 1 min depois do último salvamento.
- A planilha de destino só é gravada se estiver sem salvar há 1 min e se o cache realmente mudar.
- Cada vez só os vínculos das origens que mudaram são relidos. Relêem todos: a conferência das 03:00 (marca própria, separada da conferência das notas), "Conferir tudo", ligar os vínculos e religar a leitura automática.
- O Excel não guarda no cache uma célula usada que estava vazia na última atualização. Quando ela ganha valor na origem, o Worker a acrescenta, como o Excel faria. Quais células são usadas sai do próprio destino:
  - das fórmulas e dos nomes definidos que apontam para a origem;
  - dos nomes da origem usados pelo destino. As planilhas dos professores leem os simulados por nomes, um por turma, como `SEXTOA` = `RELAÇÃO!$J$3:$J$48`.
- Uma área grande, como coluna inteira ou `PROCV`, é percorrida pelas células que a origem tem.
- Uma aba sem nenhuma célula no cache ganha a sua tabela: no `.xlsb`, o par de registros de início e fim; no `.xlsx`, abre o `<sheetData/>`.
- Se as fórmulas não explicam todas as células do cache, também se preenchem os buracos de cada coluna, entre a primeira e a última linha guardada. Isso acontece com fórmula não lida até o fim ou com célula guardada que nenhuma fórmula usa. Fora disso, o preenchimento não roda: entre os blocos de turmas dos simulados ele acrescentaria células que nenhuma fórmula usa e regravaria à toa as planilhas dos professores.
- Mais de 50.000 células novas num vínculo é tratado como algo fora do esperado. Nenhuma célula nova entra, as já guardadas continuam atualizadas, e o vínculo aparece como sem origem acessível.
- A origem é procurada pelos ids que o Excel guarda e, se tiver sido apagada e enviada de novo, pelo endereço.
- No máximo 2 planilhas são atualizadas ao mesmo tempo, cada uma numa invocação própria (`SELF` → `/vinculos`, sem banco). Falha da Graph nos vínculos espera pelo menos 1 min sem atrasar a leitura de notas.

**Gravação segura.**
- A versão (eTag) é tirada antes do download e o envio é condicional: `createUploadSession` com `if-match`. Se alguém salvou no meio (412), nada é gravado e a planilha volta para a fila.
- Arquivo aberto no Excel para a Web ou no Excel do PC, mesmo com salvamento automático desligado, recebe 423 do servidor. Testado em 19/11/2026. O Worker tenta de novo depois de 2, 4, 8 e a cada 15 min; nessas novas tentativas pergunta antes se o arquivo continua aberto (abre e descarta uma sessão de envio, sem gravar) e só então baixa. Nunca usa `bypass-shared-lock` nem check-out.
- A versão de uma pessoa sempre vence; o Worker nunca apaga nem mescla. O histórico de versões do OneDrive guarda a versão anterior.
- Não usar a rota REST `$value` do SharePoint para isso: no teste de 19/11 ela ignorou o `If-Match` e gravou por cima de uma edição.

**Depois.**
- Ao abrir, o Excel (PC ou Web) recalcula com os valores novos, sem pedir para atualizar vínculos.
- O Excel para a Web salva o recálculo ao fechar, mesmo sem edição (testado em 19/11/2026).
- Até alguém abrir, quem lê a planilha fechada (por exemplo, a leitura automática) vê os resultados do último salvamento.
- Por isso a gravação do Worker não faz a leitura automática reler uma planilha de professor cujas notas já tinham sido lidas na versão sobrescrita; o salvamento do recálculo, ao abrir, é lido normalmente.

**Painel.** Banco de notas › Importação › OneDrive › **Vínculos entre planilhas**:
- ligar e desligar;
- escolher pastas ou planilhas de destino;
- "Conferir tudo";
- por planilha: situação, hora da última conferência e da última atualização, e "Atualizar agora".

A atualização só roda com a leitura automática ligada e não pausada.

**Em uso (19/11/2026).**
- Os vínculos estão ligados só na pasta `PEDAGÓGICO/CONTROLE DE NOTAS/CONTROLE DE NOTAS 2026`, com as 18 planilhas dos professores. As origens delas são a Relação 2026 e os 3 simulados.
- O Banco de Notas 2026 (`.xlsb`) não é mais usado: o Ecossistema o substituiu, e ele fica fora dos vínculos.
- Na primeira conferência, as 18 planilhas ficaram sem mudança, como na previsão feita em cópias.

**Teste em produção (19/11/2026), na pasta sintética já apagada:**
- **Gravação:** cerca de 70 s depois de a origem ser salva, mudando só 2 partes do arquivo.
- **Arquivo aberto:** 423 com o arquivo aberto no Excel para a Web e no Excel do PC (documento da nuvem, com AutoSave); o Worker tentou de novo depois de 2 e de 4 min.
- **Versão de uma pessoa:** depois de o arquivo ser fechado, a gravação partiu da versão salva pelo Excel para a Web.
- **"Atualizar agora" e "Conferir tudo":** esperaram o arquivo ficar 1 min sem salvar e terminaram sem mudança.

**Escritor único.** Planilhas atualizadas por aqui não devem estar também numa tarefa do Atualizador de Planilhas do PC: os dois desfariam um ao outro.

**Permissão.** Papel `write` do app Graph Backend (`Sites.Selected`) no site do OneDrive da secretaria, concedido em 19/11/2026 com autorização do responsável.

**Validação.**
- Medido nas planilhas reais, só leitura: as 18 de professores estavam em dia, e o Banco tinha 4.998 células atrasadas, confirmadas uma a uma no Excel (88.082 células iguais).
- O Excel abre os arquivos remontados sem reparo, com macros e vínculos.
- Conferência de 19/11/2026 à tarde, feita em cópias e só com leitura:
  - Nos 88 vínculos das 19 planilhas, toda célula do cache está entre as usadas pelas fórmulas e pelos nomes. As exceções são 2 células antigas de uma planilha, que nenhuma fórmula usa mais.
  - Banco: o cache montado pelo Worker é igual ao gravado pelo próprio Excel ao atualizar os vínculos, em 88.082 de 88.082 células, com 6.402 mudanças.
  - Banco: os valores recalculados das 10 abas são iguais em 139.382 células.
  - Uma planilha de professor atualizada pelo Excel não muda, e o Worker também não a regrava.
- Arquivos sintéticos feitos no Excel, em `.xlsb` e `.xlsx`, deram resultado idêntico ao do Excel nestes casos:
  - célula nova num nome;
  - nome de uma célula só;
  - aba sem células no cache;
  - `PROCV` em coluna inteira;
  - célula vazia preenchida depois.
- Ler as 18 origens do Banco leva cerca de 6 s de processamento. Só a última origem lida fica na memória, porque guardar todas ocuparia cerca de 40 MB. É o caso mais pesado, e o Banco já não é usado.

**Limites.**
- Origem fora do OneDrive da secretaria ou maior que 8 MiB fica como está e aparece como "vínculo sem origem acessível".
- Cópia de conflito numa pasta de fontes ainda seria lida como mais uma planilha (regra própria, fora desta entrega).
- A escola não reorganiza a Relação; reordenar a lista desalinharia nomes e notas, como no próprio Excel.
- No `.xlsb`, um nome da origem que passe da linha 65.536 é gravado pelo Excel como erro, sem a área. As células dele só são atualizadas se já estiverem no cache.
- No `.xlsx`, uma referência a várias abas de outra pasta (`[1]A:C!B2`) não é lida. Então vale o preenchimento de buracos.

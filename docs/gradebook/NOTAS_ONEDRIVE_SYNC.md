# Leitura automática das planilhas de notas (OneDrive)

O Worker `notas-onedrive-sync` lê as planilhas de notas dos professores na pasta do OneDrive da secretaria e lança só o que mudou, alguns segundos depois do salvamento. Usa o mesmo leitor, a mesma Auditoria e a mesma importação autoritativa do botão de importação.

## Como funciona

1. A Graph avisa (webhook) que algo mudou no OneDrive; a consulta *delta* diz quais arquivos da pasta mudaram.
2. Cada arquivo tem uma leitura por vez. Um salvamento durante a leitura faz o arquivo ser relido logo depois. Arquivo com o mesmo *hash* da última leitura é pulado sem download.
3. A leitura grava primeiro a Auditoria e depois as notas, quando nada bloqueia. Arquivo com erro de auditoria não é lançado.
4. Depois de gravar, o Portal recebe o aviso ao vivo; a publicação continua sendo decidida na tela de publicação.
5. Rede de segurança: *delta* de hora em hora (a cada minuto se o webhook não estiver ativo) e conferência completa da pasta às 03:00.
6. Disjuntor: 5 falhas seguidas pausam a leitura por 15 minutos.

Apagar um arquivo da pasta **não apaga notas**: o arquivo só fica marcado como removido.

## Estado

O estado operacional (configuração, status por arquivo, posição do *delta*, assinatura do webhook, disjuntor e registro de alterações) fica no armazenamento SQLite do Durable Object `NotasSyncCoordinatorV1`. Notas e Auditoria ficam no PostgreSQL, como hoje. Não há migration de banco.

## Operação

O Worker começa **desligado**. Até o painel do Centro de Administração (PR 3), a operação usa rotas protegidas por `NOTAS_SYNC_PROBE_TOKEN` (`Authorization: Bearer …`):

| Rota | Uso |
| --- | --- |
| `POST /sonda` | Lista a pasta e lê uma planilha sem gravar; `?webhook=1` testa a assinatura; `?arquivo=N` escolhe a planilha |
| `GET /status` | Configuração, disjuntor, webhook e status de cada arquivo |
| `POST /controle` | `{"action":"enable"}`, `disable`, `pause`, `resume`, `read-all`, `{"action":"set-wait","seconds":0}`, `{"action":"set-parallel","count":6}`, `{"action":"read-now","fileId":"…"}` |

Ao ligar pela primeira vez, todas as planilhas da pasta são lidas e lançadas uma vez (como uma importação completa).

## Segredos

`GRAPH_CREDENTIAL_A`/`B` são gravados pelo `entra-maintenance.yml` ao rotacionar a Graph. `NOTAS_SYNC_CLIENT_STATE` e `NOTAS_SYNC_PROBE_TOKEN` são valores aleatórios definidos uma vez no Worker. O Worker é publicado pelo `deploy-cloudflare-pages.yml`.

## Privacidade

Logs e respostas de status têm só contagens, tempos, códigos e nomes de arquivo; nunca nomes de alunos ou notas.

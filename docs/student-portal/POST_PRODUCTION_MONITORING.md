# Monitoramento simples do Portal do Aluno

## Rotina diária

1. Entre em **Painel do Aluno → Visão geral**, use **Atualizar visão geral** e confirme **Operando normalmente**.
2. Entre em **Configurações** e confirme **População ativa** e **0 perfis ainda não criados**.
3. Observe se apareceram contas bloqueadas, vínculos não resolvidos ou trabalho pendente. Esses números podem existir legitimamente; investigue qualquer aumento inesperado.
4. Entre em **Publicação** somente quando decidir divulgar um período. A publicação é manual; a atualização automática atua apenas nos períodos que já foram publicados.
5. Em **Auditoria**, confira as operações administrativas recentes quando houver dúvida sobre bloqueio, QR, senha, nascimento, configuração ou publicação.

Faça essa consulta também depois de importar a Relação, mover alunos de turma, alterar notas já publicadas ou executar ações em lote.

## Quando algo falhar

Anote:

- data e hora aproximadas;
- endereço da tela, removendo qualquer trecho depois de `#v1.` de um QR;
- ação realizada e mensagem exibida;
- escopo geral ou nome da turma, sem nome de aluno;
- se ocorreu na primeira tentativa e se a repetição funcionou;
- estado mostrado em **Visão geral** e contagens agregadas relevantes.

Não envie QR, senha, PIN, ano de nascimento, cookie, token, chave, nome ou nota de aluno. Não envie uma captura que mostre esses dados. Se o caso for individual, chame a pessoa de “aluno afetado” e mantenha a investigação dentro do painel autenticado.

## Modelo para pedir ajuda à IA

Copie e preencha:

```text
Portal do Aluno — incidente pós-produção
Horário aproximado:
Tela/rota sem credenciais:
Ação realizada:
Mensagem exata sem dados pessoais:
Escopo: escola ou turma (sem aluno):
Primeira tentativa ou repetição:
Saúde na Visão geral:
Contagens agregadas relevantes:
Resultado esperado:
Resultado observado:
```

Peça à IA primeiro um diagnóstico sem alteração de dados. Se houver correção, solicite issue, branch, testes, revisão, deploy oficial e verificação sanitizada. Diga expressamente que nomes, notas, QR, credenciais e identificadores de alunos não podem aparecer em issue, commit, log ou captura.

## Sinais que pedem intervenção

- **Intervenção necessária** na saúde operacional;
- perfis faltantes após uma nova Relação;
- aumento de vínculos não resolvidos;
- trabalho pendente além da janela esperada, sinalizado na saúde operacional;
- erro repetido de login após uma segunda tentativa limpa;
- período confirmado como publicado que não aparece para uma conta elegível;
- conta de saída que ainda mantém sessão ou conteúdo visível.

Nesses casos, preserve o horário e a mensagem, evite repetir ações destrutivas e abra uma issue específica. O acesso geral pode ser desligado em **Configurações** enquanto o diagnóstico ocorre; isso não apaga contas, notas ou histórico.

## Sinais técnicos nos logs (#1207)

Os logs do Worker e do edge trazem eventos de formato fixo, sem nome, ID, URL, caminho, token ou mensagem de erro. Eles são contados na consulta; cada linha isolada não identifica ninguém.

| Evento | Onde | Campos | Para que serve |
| --- | --- | --- | --- |
| `student-portal-operation-v1` | Worker | operação, resultado, tempo e contagens de SQL | latência e indisponibilidade por operação (`auth`, `self`, `live`, …) |
| `student-portal-db-lifecycle-v1` | Worker | (até 14/11/2026) operação, `openRoleMs`, `applicationMs`, `attempts` | desde a issue #1426 (22c), esses três campos vêm na própria linha `student-portal-operation-v1`; o evento não é mais emitido |
| `student-portal-auth-result-v1` | Worker | etapa (`challenge`/`activate`/`login`), resultado terminal, `next` só em `required` | denominador das chamadas ao serviço de login: `issued`, `required`, `denied`, `blocked` (retorno `rate-limited`, incluindo burst e bloqueio temporário por tentativas; não distingue a causa), `access-closed`, `invalid-request`, `unavailable`. Não traz motivo |
| `student-portal-live-close-v1` | Durable Object do canal ao vivo | callback (`close`/`error`), classe do código, `readyState` | ciclo de fechamento dos canais. A classe descreve o código, não a causa: `no-status` é fechamento sem código (a rotação do navegador é uma origem possível, não comprovada); `abnormal` é fim anormal (não determina rede ou aba suspensa). É emitido antes de responder ao fechamento e não prova que o navegador recebeu a resposta |
| `student-portal-edge-result-v1` | edge | família da rota, ramo tomado, status | atribui 403/404/503 do edge a uma família (`document`, `asset`, `icon-probe`, `health`, `diagnostic`, `api`, `other`) e ao ramo (`origin-rejected`, `asset-miss`, `route-miss`, `forwarded`, …) |

- Os motivos de recusa ficam só no detalhe da auditoria (migration 0023, fonte única), nos eventos auditados e sem retroatividade: as recusas anteriores à #1208 não têm motivo, e recusas sem conta reconhecida (QR desconhecido, desafio inexistente) não são auditadas. A partir da #1208 a auditoria também registra tentativas durante um bloqueio já existente, então o total de recusas antes e depois dela não é comparável.
- `password-window-expired` indica prazo comprovadamente vencido do desafio ou fim da janela permitida para emiti-lo; desafio já usado ou de outra versão, sem prova de prazo vencido, aparece como `retry-needed` ("Nova tentativa necessária").
- `/healthz` é só liveness: responde sem tocar no banco. A saúde do caminho PostgreSQL vem de `/api/student/status` e dos eventos acima com `outcome=unavailable`.
- Limiares de triagem de latência (baseline do lançamento de 28/09: p95 `auth` 989 ms, `self` 552 ms, `live` 309 ms): investigar quando, em janelas de 5 min com pelo menos 20 sucessos da operação, o p95 passar de 2× a baseline por duas janelas seguidas. Qualquer `unavailable` pede triagem imediata. São limiares de diagnóstico, não SLO.
- Cada aba autenticada aberta renova o canal de segurança a cada 45 s, com uma transação curta de leitura por renovação. Isso é esperado e entra no modelo de capacidade como cenário, não como medição.
- Não somar `auth-result-v1`, `auth-burst-v1` e auditoria como se fossem tentativas distintas: cada um conta um universo diferente.

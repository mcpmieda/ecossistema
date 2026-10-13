# Fallback sintético da #1269 — QA e KDF

Execução local em **2026-10-12 UTC**, com dados, contas, chaves e banco **exclusivamente sintéticos**. Nenhum dado acadêmico real, credencial produtiva, deploy, preview remoto ou binding produtivo foi usado. Esta rodada acrescenta provas sintéticas mais estritas, uma prévia local de navegador para as três telas e uma prova local complementar de concorrência do `stage`, sem alterar KDF, custos ou thresholds.

## Provas sintéticas reforçadas nesta rodada

- `tests/student-identity/student-report-import-v1.test.tsx`
  - troca de arquivo com resposta atrasada agora libera a `Promise` original explicitamente e faz `act/flush` antes das asserções;
  - conflito/stale de catálogo agora prova que o **segundo** `prepare` usa `generation`/`expectedRevision` atualizados;
  - fechar a tela durante `stage` agora desmonta o componente por fora, confere `signal.aborted`, resolve uma resposta tardia `ready:true` e ainda assim garante ausência de `apply` ou nova etapa.
- `tests/student-identity/reconciliation-ui-v1.test.tsx`
  - resposta atrasada da lista anterior agora libera a `Promise` explicitamente e faz `act/flush` antes das asserções;
  - o conflito de CAS em `confirm` clona o payload enviado e confere `studentUid`/`expectedLinkVersion`;
  - a repetição após resposta perdida clona cada payload `resolve` e prova o reenvio idêntico de `sourceId`/`studentUid`/`expectedLinkVersion`;
  - o caso de nomes longos prova a escolha de **outra observação inteira já ligada da mesma pessoa**; ele não é descrito como persistência N→1 integrada.
- `tests/gradebook/import/relation-movement-review-ui-v9.test.tsx`
  - cobertura de nomes longos na conferência explícita de transferências preservada.

## QA em navegador real — evidência sanitizada

Prévia local adicionada:

- `reconciliation-qa-preview.html`
- `src/reconciliation-qa-preview/main.tsx`

Ela renderiza as três telas com fixtures 100% sintéticas e um roteiro automático opcional via `?autoplay=1`, sem PIN, verificador, QR útil ou segredo em DOM, logs ou screenshots.

### Execução real observada

- Navegador: `chromium --headless --no-sandbox`
- Largura efetiva observada:
  - **desktop:** `1440px`
  - **mobile estreito:** `500px`
- Evidências locais sanitizadas geradas nesta rodada:
  - DOM final: `/tmp/reconciliation-qa-desktop.html`, `/tmp/reconciliation-qa-mobile.html`
  - screenshots locais: `/tmp/reconciliation-qa-desktop.png`, `/tmp/reconciliation-qa-mobile.png`

### Resultado do roteiro automático

Tanto em desktop quanto em mobile estreito, a própria página registrou como **Aprovado**:

1. foco do botão principal do Relatório;
2. fluxo sintético completo do Relatório (`catalog → prepare → stage → stage → apply`);
3. foco do campo de busca da aba Alunos;
4. visibilidade dos nomes longos na aba Alunos;
5. alerta sintético de conflito/CAS na aba Alunos;
6. foco do `<select>` da conferência de transferências;
7. habilitação da confirmação após seleção completa dos pares;
8. ausência de overflow horizontal da página:
   - desktop: `clientWidth=1425`, `scrollWidth=1425`;
   - mobile: `clientWidth=485`, `scrollWidth=485`.

## Harness real reutilizado para stage/KDF

O caminho real já existente para a KDF sintética local continua sendo:

1. `tests/student-portal/runtime/reconciliation-credentials.postgres.ts` valida `stage`/`apply` nativos em PostgreSQL descartável;
2. `tests/student-portal/runtime/migrations.postgres.ts`, teste **"runs synthetic account activation, sessions and bounded load through real workerd/PostgreSQL"**, sobe `workerd`/Miniflare com `tests/student-portal/load/harness-worker.ts`;
3. o endpoint sintético `/harness/reconciliation/stage` chama `prepareReconciliationCredentialsV1`, que por sua vez executa a KDF real de `PortalCryptoV1.deriveVerifier`;
4. `tests/student-portal/load/harness-diagnostics-v1.ts` exporta o envelope medido sem incluir corpos, QR, PIN, cookies ou IDs.

## Ambiente e limites efetivamente usados

- Node `v22.23.3`
- Linux `x64`
- `availableParallelism=4`
- CPU host reportada pelo SO: `AMD EPYC 7763 64-Core Processor`
- memória total do host reportada pelo SO: `16,766,410,752` bytes
- memória livre do host no export do harness: `13,881,069,568` bytes
- banco descartável loopback: `postgres://portal_test_admin@127.0.0.1:55439/portal705_test`
- massa sintética do estágio no harness: **5 contas**, com no máximo **4 derivações sequenciais** na primeira chamada e a quinta derivação na chamada seguinte
- budgets vigentes do harness: `reconciliation-stage p95 <= 2000ms`, `p99 <= 3000ms`, `<= 65` consultas

## Resultado local observável do stage/KDF via workerd

Envelope exportado pelo próprio harness (`PORTAL_TEST_METRICS_PATH`) no teste runtime local:

| Métrica `reconciliation-stage` | Valor |
| --- | ---: |
| amostras | 5 |
| p50 externo | 21 ms |
| p95 externo | 764 ms |
| p99 externo | 764 ms |
| máximas consultas/linhas/bytes | 7 / 7 / 58 |

Detalhe das cinco amostras:

1. **1ª chamada com KDF** — `preparedCount=4`, `remainingCount=1`, `ms=764`, `x-harness-ms=754`, `queries=7`, `rows=7`
2. **2ª chamada com KDF** — `preparedCount=5`, `remainingCount=0`, `ms=209`, `x-harness-ms=199`, `queries=4`, `rows=4`
3. **3ª chamada (`ready` repetido, sem nova derivação)** — `ms=20`, `x-harness-ms=12`, `queries=2`, `rows=2`
4. **4ª chamada (`ready` repetido, sem nova derivação)** — `ms=21`, `x-harness-ms=13`, `queries=2`, `rows=2`
5. **5ª chamada (`ready` repetido, sem nova derivação)** — `ms=19`, `x-harness-ms=12`, `queries=2`, `rows=2`

No mesmo run, as fases `self-*` e `login-*` de concorrência `1/2/5` também ficaram dentro dos budgets já contratados; isso confirma o fluxo sintético completo do harness, **não** mede CPU faturada ou pico de memória da KDF.

## Concorrência local específica de `stage`

Prova adicional acrescentada em `tests/student-portal/runtime/reconciliation-credentials.postgres.ts`:

- dois lotes independentes de **5 contas** cada foram preparados em paralelo, com **duas conexões `student_portal_app` separadas**;
- **1ª rodada concorrente:** ambos retornaram `{ state: 'preparing', preparedCount: 4, remainingCount: 1 }`, e a tabela de stage ficou em `{ prepared: 4, remaining: 1 }` para cada lote;
- **2ª rodada concorrente:** ambos retornaram `{ state: 'ready', preparedCount: 5, remainingCount: 0 }`, com `{ prepared: 5, remaining: 0 }` para cada lote;
- antes do `apply`, os snapshots das duas populações permaneceram idênticos ao estado inicial;
- ao aplicar o primeiro lote, somente a primeira população mudou para o ano de credencial sintético `2014`; a segunda permaneceu intacta e reteve seu próprio stage `{ prepared: 5, remaining: 0 }`;
- ao aplicar o segundo lote, a segunda população mudou para `2015`, e os stage rows dos dois lotes foram limpos.

Essa prova fecha **localmente** os observáveis pedidos para lotes/contas independentes e o limite de quatro derivações por request. Ela não transforma wall-clock, RSS, heap ou memória livre do host em evidência de CPU faturada ou pico de memória do isolate.

## Lacunas que continuam abertas

1. **CPU faturada e pico de memória do isolate continuam indisponíveis neste ambiente.** O harness local expõe apenas `ms` externo e `x-harness-ms` parcial da aplicação. Esses números são úteis para budget local, mas **não equivalem** à CPU faturada do runtime nem ao pico de memória nativa do isolate.
2. **RSS/heap/process/free-memory do host não foram tratados como prova.** Eles descrevem o processo/host Linux e podem ser capturados como contexto, mas o contrato da #1269/`RECONCILIATION_V1.md` continua proibindo usá-los como aprovação de CPU/pico de memória da KDF.
3. **A nova concorrência específica de `stage` ficou provada apenas no runtime local/PostgreSQL.** Ela não substitui uma medição autorizada de CPU faturada ou pico de memória em isolate/workerd produtivo.
4. **Nenhuma métrica remota da Cloudflare foi usada.** Não houve worker temporário remoto, GraphQL de analytics, preview público ou credencial nova para esta rodada.

## Comandos reproduzíveis usados nesta rodada

1. **UI sintética em navegador real:**

   ```bash
   npm run dev -- --host 127.0.0.1 --port 4176
   chromium --headless --disable-gpu --no-sandbox --window-size=1440,1800 \
     --virtual-time-budget=15000 \
     --dump-dom "http://127.0.0.1:4176/reconciliation-qa-preview.html?autoplay=1"
   chromium --headless --disable-gpu --no-sandbox --window-size=390,1800 \
     --virtual-time-budget=15000 \
     --dump-dom "http://127.0.0.1:4176/reconciliation-qa-preview.html?autoplay=1"
   ```

2. **Provas sintéticas de UI em Vitest/JSDOM:**

   ```bash
   npx vitest run \
     tests/student-identity/student-report-import-v1.test.tsx \
     tests/student-identity/reconciliation-ui-v1.test.tsx \
     tests/gradebook/import/relation-movement-review-ui-v9.test.tsx
   ```

3. **Concorrência local específica de `stage`:**

   ```bash
   PORTAL_TEST_DATABASE_URL=postgres://portal_test_admin@127.0.0.1:55439/portal705_test \
     npx vitest run --config tests/student-portal/runtime/vitest.postgres.config.ts \
     tests/student-portal/runtime/reconciliation-credentials.postgres.ts
   ```

4. **Harness real `workerd` + PostgreSQL com export do envelope:**

   ```bash
   PORTAL_TEST_METRICS_PATH=/tmp/reconciliation-harness-diag.json \
   PORTAL_TEST_DATABASE_URL=postgres://portal_test_admin@127.0.0.1:55439/portal705_test \
     npx vitest run --config tests/student-portal/runtime/vitest.postgres.config.ts \
     tests/student-portal/runtime/migrations.postgres.ts \
     -t "runs synthetic account activation, sessions and bounded load through real workerd/PostgreSQL"
   ```

Este fallback sintético **não declara aprovação de CPU faturada ou pico de memória da KDF para produção**. Ele entrega a evidência local disponível nesta sandbox, registra o QA real de navegador com dados sanitizados e mantém explícita a lacuna que continua dependente de instrumentação/runtime autorizado.

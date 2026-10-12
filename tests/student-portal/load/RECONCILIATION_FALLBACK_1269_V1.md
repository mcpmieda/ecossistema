# Fallback sintético da #1269 — QA e KDF

Execução local em **2026-10-12 UTC**, com dados, contas, chaves e banco **exclusivamente sintéticos**. Nenhum dado acadêmico real, credencial produtiva, deploy, preview remoto ou binding produtivo foi usado. A árvore runtime medida era a já integrada na branch em `8bc824c6d53effb0a7071fce1da591aa207002a8`; esta rodada acrescenta somente regressões sintéticas e este relatório.

## QA sintético acrescentado nesta rodada

- `tests/student-identity/student-report-import-v1.test.tsx`
  - troca de arquivo com resposta atrasada do relatório anterior;
  - conflito/stale de catálogo antes do prepare final;
  - fechar a tela durante `stage`, sem `apply` posterior.
- `tests/student-identity/reconciliation-ui-v1.test.tsx`
  - resposta atrasada da lista anterior após troca de busca;
  - `reject`, `release` e `confirm`;
  - resposta perdida com `Repetir mesma solicitação`;
  - conflito/CAS ao confirmar vínculo;
  - N→1 com escolha explícita de outra observação inteira e nomes longos.
- `tests/gradebook/import/relation-movement-review-ui-v9.test.tsx`
  - nomes longos na conferência explícita de transferências.

Esses testes complementam os casos já existentes de seleção vazia/completa/inválida, cancelamento e pares desiguais.

## Harness real reutilizado

O caminho real já existente para a KDF sintética local é:

1. `tests/student-portal/runtime/reconciliation-credentials.postgres.ts` valida o estágio/aplicação nativos no PostgreSQL descartável;
2. `tests/student-portal/runtime/migrations.postgres.ts`, teste **"runs synthetic account activation, sessions and bounded load through real workerd/PostgreSQL"**, sobe `workerd`/Miniflare com `tests/student-portal/load/harness-worker.ts`;
3. o endpoint sintético `/harness/reconciliation/stage` chama `prepareReconciliationCredentialsV1`, que por sua vez executa a KDF real de `PortalCryptoV1.deriveVerifier`;
4. `tests/student-portal/load/harness-diagnostics-v1.ts` exporta o envelope medido sem incluir corpos, QR, PIN, cookies ou IDs.

## Ambiente e limites efetivamente usados

- Node `v22.23.3`
- Linux `x64`
- `availableParallelism=4`
- CPU host reportada pelo SO: `AMD EPYC 9V74 80-Core Processor`
- memória total do host reportada pelo SO: `16,766,406,656` bytes
- banco descartável loopback: `postgres://portal_test_admin@127.0.0.1:55439/portal705_test`
- massa sintética do estágio: **5 contas**, com no máximo **4 derivações sequenciais** na primeira chamada e a quinta derivação na chamada seguinte
- budgets vigentes do harness: `reconciliation-stage p95 <= 2000ms`, `p99 <= 3000ms`, `<= 65` consultas

## Resultado local observável do estágio/KDF

Envelope exportado pelo próprio harness (`PORTAL_TEST_METRICS_PATH`) no teste runtime local:

| Métrica `reconciliation-stage` | Valor |
| --- | ---: |
| amostras | 5 |
| p50 externo | 23 ms |
| p95 externo | 863 ms |
| p99 externo | 863 ms |
| máximas consultas/linhas/bytes | 7 / 7 / 58 |

Detalhe das cinco amostras do estágio:

1. **1ª chamada** — `preparedCount=4`, `remainingCount=1`, `ms=863`, `x-harness-ms=851`, `queries=7`, `rows=7`
2. **2ª chamada** — `preparedCount=5`, `remainingCount=0`, `ms=233`, `x-harness-ms=224`, `queries=4`, `rows=4`
3. **3ª chamada** — `ready` repetido, `ms=20`, `x-harness-ms=13`, `queries=2`, `rows=2`
4. **4ª chamada** — `ready` repetido, `ms=23`, `x-harness-ms=13`, `queries=2`, `rows=2`
5. **5ª chamada** — `ready` repetido, `ms=20`, `x-harness-ms=12`, `queries=2`, `rows=2`

No mesmo run, as fases `self-*` e `login-*` de concorrência `1/2/5` também ficaram dentro dos budgets já contratados; isso confirma o fluxo sintético completo do harness, **não** mede CPU ou pico de memória da KDF.

## Lacunas que continuam abertas

1. **CPU faturada e pico de memória do isolate não ficaram mensurados fielmente neste ambiente.** O harness local expõe apenas `ms` externo e `x-harness-ms` parcial da aplicação. Esses números são úteis para budget local, mas **não equivalem** à CPU faturada do runtime nem ao pico de memória nativa do isolate.
2. **RSS/heap/process/free-memory do host não foram tratados como prova.** Eles descrevem o processo/host Linux e podem ser capturados como contexto, mas o próprio contrato da #1269/`RECONCILIATION_V1.md` proíbe usá-los como aprovação de CPU/pico de memória da KDF.
3. **A concorrência 1/2/5 existente no harness cobre `self`/`login` depois da ativação, não chamadas simultâneas isoladas de `stage` com lotes independentes.** Portanto, esta fallback local prova o caminho real com no máximo quatro derivações sequenciais por request e budgets de request/SQL, mas **não encerra** a lacuna de uma prova dedicada de concorrência específica da KDF.
4. **Nenhuma métrica remota da Cloudflare foi usada.** Não houve worker temporário remoto, GraphQL de analytics, preview público ou credencial nova para esta rodada.

## Comandos reproduzíveis usados nesta rodada

1. Validar a atomicidade nativa do estágio/aplicação:

   ```bash
   PORTAL_TEST_DATABASE_URL=postgres://portal_test_admin@127.0.0.1:55439/portal705_test \
     npx vitest run --config tests/student-portal/runtime/vitest.postgres.config.ts \
     tests/student-portal/runtime/reconciliation-credentials.postgres.ts
   ```

2. Resetar o banco descartável `portal705_test` e exportar o envelope do harness real:

   ```bash
   PORTAL_TEST_METRICS_PATH=/tmp/reconciliation-harness-diag.json \
   PORTAL_TEST_DATABASE_URL=postgres://portal_test_admin@127.0.0.1:55439/portal705_test \
     npx vitest run --config tests/student-portal/runtime/vitest.postgres.config.ts \
     tests/student-portal/runtime/migrations.postgres.ts \
     -t "runs synthetic account activation, sessions and bounded load through real workerd/PostgreSQL"
   ```

Este fallback sintético **não declara aprovação de CPU ou pico de memória da KDF para produção**. Ele entrega a evidência reprodutível local disponível nesta sandbox e registra exatamente a lacuna que continua dependente de instrumentação/runtime autorizado.

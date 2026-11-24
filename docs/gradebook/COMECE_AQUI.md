# Banco de Notas — estado operacional

## Continuidade atual — 20/09/2026

O programa funcional BN permanece encerrado. A manutenção atual está consolidada na **#970**; suas issues filhas devem partir da `main` factual e não reabrir a antiga fila Portal Parte 2 #742.

Baseline de reconciliação: `main@cad68337b48c7d4a40477b088d36835c705246f2`. Estado comprovado nesta rodada:
- Gradebook: 30 tabelas; migration corrente `0012_current_state_cleanup_v1.sql`, aplicada e verificada em #863;
- Student Portal: 27 tabelas privadas; migration corrente `0015_student_portal_rls_v1.sql`, aplicada e verificada em #859/#963;
- backup gerenciado/RPO/RTO continua não implementado;
- `historical_checkpoint_668` é memória, não autorização atual.

O Git, o CI e a produção são estados diferentes. Use `PROJECT_STATE.yaml` para a baseline auditada e as issues/deploys citados para a prova de aplicação. A presença de uma migration na árvore não autoriza inferir que ela foi executada.

Data da consolidação: 11/09/2026 (America/Sao_Paulo).

O programa relacional está implementado, publicado e exercitado. FINAL-1 #633, FINAL-2 #634, FINAL-3 #635, FINAL-4 #406 e o aceite acadêmico #347 estão encerrados. A matriz do piloto está em [FINAL4_PILOT_406.md](FINAL4_PILOT_406.md) e a operação final em [FINAL_OPERATION_596.md](FINAL_OPERATION_596.md).

Baseline factual desta memória: `main@80b2916185fc6a49df7c5ab0af71e2be4dcdeb66`, CI `34667519751` e deploy `34667699446` verdes. Usar sempre `main` + branch + PR + issues + CI como estado mais recente; `PROJECT_STATE.yaml` é apenas um resumo auditado e pode ficar atrás do head.

## Contrato vigente

- PostgreSQL/Supabase via Hyperdrive `PROD_DB` é a persistência atual.
- `imported-source` é a autoridade dos consumidores; `native-engine` permanece descritivo.
- 2026 é o ano oficial em curso. A massa materializada de 2025 é descartável e serve apenas para teste integral.
- O ano é selecionado globalmente e isola dados e identidades. Comparação existe somente entre trimestres do mesmo ano.
- R/R em qualquer componente implica `REPROVADO` e o Conselho não delibera sobre o aluno; desde 23/11/2026 (BN-DEC-049) ele aparece nos cartões do Conselho só para conhecimento.
- Conselho: desde 23/11/2026 (BN-DEC-049, #1558) guarda só o estado atual e a reunião só abre; o registro da decisão humana e a contagem de votos estão em refação. Desempate do diretor ocorre fora do sistema. Ver [RELATIONAL_COUNCIL_V3.md](RELATIONAL_COUNCIL_V3.md).
- Situação do aluno vem exclusivamente da Relação; AM/U vêm da fonte importada.

## Limite operacional aceito

Backup/restore gerenciado, retenção, RPO e RTO não estão implementados. O responsável decidiu adiar esse trabalho e operar por enquanto sem a garantia. A restauração local da #662 não deve ser apresentada como backup institucional, e o D1 histórico não recupera escritas novas.

## Ordem de leitura

1. [FINAL_OPERATION_596.md](FINAL_OPERATION_596.md): rotina, responsabilidades, monitoramento e incidente.
2. [FINAL4_PILOT_406.md](FINAL4_PILOT_406.md): matriz sanitizada do percurso integral.
3. [DECISIONS.md](DECISIONS.md): decisões e limites normativos.
4. [ARCHITECTURE.md](ARCHITECTURE.md), [CONSUMER_MAP.md](CONSUMER_MAP.md) e [CONTRACTS.md](CONTRACTS.md): arquitetura e contratos.
5. [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md), [ROADMAP.md](ROADMAP.md), [ISSUE_MAP.md](ISSUE_MAP.md) e [TEST_MATRIX.md](TEST_MATRIX.md): evidências e histórico executável.

Toda mudança segue `issue → branch → commit → npm run verify → CI do head → revisão → merge por SHA → deploy oficial → smoke`. BN-DEC-023 dispensa confirmação por PR concluída, não autoriza publicar check falhando nem ampliar regra, dado, schema, autoridade ou infraestrutura.

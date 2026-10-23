# Student Portal PostgreSQL migrations

Owner: #704 (`[PA][P1]`, family P1-02). The migrations are separate from `migrations/gradebook*`; `0019` is destructive.

## Ledger

| Migration | Purpose |
| --- | --- |
| `0001_identity_credentials_acl_v1.sql` | private schema, runtime role, account/link, birth access data, QR/password credentials, sessions and auth state |
| `0002_policy_publication_revision_v1.sql` | settings, publication/projection/jobs, durable revision state/events and narrow 2026 academic read views |
| `0003_audit_receipts_closure_integration_v1.sql` | audit, idempotency receipts, explicit link tombstones, reset preview proof and narrow Gradebook revision function |
| `0004_gradebook_integration_usage_v1.sql` | namespace-only integration ACL plus read-only reset guard function for `gradebook_app`; no table privilege |
| `0005_year_reset_protocol_v1.sql` | #706: amplia a coordenação técnica do reset ao intervalo anual do BN, inicializa revisão por ano e cria guards sem conceder DML acadêmico |
| `0006_gradebook_revision_year_range_v1.sql` | #706: amplia `record_gradebook_change_v1` ao intervalo anual contratado, preservando idempotência e revisões duráveis |
| `0007_lifecycle_integration_v1.sql` | #707: adiciona controle/snapshot de lifecycle, preview de fechamento de vínculos e sincronização de perfis com população inicialmente desabilitada |
| `0008_atomic_publication_v2.sql` | #803: introduz preparação/publicação V2 atômica e escopada, inicialmente desabilitada, sem alterar fatos acadêmicos |
| `0009_publication_cutover_guard_v2.sql` | bloqueia escritores legados de publicação/projeção/jobs quando o cutover V2 escopado estiver ativo |
| `0010_incremental_publication_v3.sql` | #806: acrescenta preparação incremental V3 e métricas sem mudar decisões de publicação nem notas |
| `0011_live_event_outbox_v1.sql` | #808: outbox transacional mínimo para avisos live autenticados, contendo apenas roteamento e versões opacas |
| `0012_granular_observations_names_v1.sql` | #817: projeta nomes de avaliações e observação granular no Portal e restringe emissão live ao ano 2026; depende de Gradebook 0009 |
| `0013_publication_inheritance_v1.sql` | #827: marca herança lógica da decisão do escopo pai sem apagar release nem copiar fatos acadêmicos |
| `0014_year_reset_full_cleanup_v1.sql` | mantém o contrato do reset anual e remove, ao concluir, eventos de revisão, provas técnicas e coordenação anual do ano apagado |
| `0015_student_portal_rls_v1.sql` | defesa em profundidade #859: RLS não-forçado nas 27 tabelas privadas, policy restrita a `student_portal_app` e ACL existente preservada |
| `0016_audit_entities_v1.sql` | #1102 (aplicada em produção em 22/09/2026, versão `20260922150000`): rótulos históricos de operador/aluno/turma em `audit_event`, sem backfill fabricado nem novas permissões |
| `0017_security_event_priority_v1.sql` | #1101 (aplicada em produção em 22/09/2026, versão `20260922150001`): marca `security_relevant` no outbox live para o canal exclusivo de segurança, sem novo payload protegido |
| `0018_shared_student_identity_v1.sql` | #1114 (aplicada e verificada em produção, versão `20260922212633`): identidade durável compartilhada em `student_uid`, backfill por vínculos existentes, FKs e imutabilidade; preserva IDs, credenciais e referências de fotos. Evidência: `docs/student-identity/POSTFLIGHT_1114.md` |
| `0019_remove_legacy_projection_v1.sql` | PR #1122 (aplicada e verificada em produção em 23/09/2026, versão `20260923164053`): após o deploy do Worker sem leitura legada e com V2 ativa, removeu `published_projection` e redefiniu `synchronize_profiles_v1` sem a exclusão dessa projeção. O responsável confirmou a exibição de notas por login real após a migração. Os dados removidos não têm rollback por código. Evidência: `docs/student-portal/POSTFLIGHT_0019.md` |
| `0020_term_closing_policy_v1.sql` | #1132 (aplicada e verificada em produção em 23/09/2026, versão `20260923193137`): aceita os campos de política do Fechamento do trimestre (`showTermClosing` desligado, `termClosingConclusive` ligado) e semeou os padrões da escola na época atual. Aditiva, aplicada depois do deploy do Worker da #1136. Evidência: `docs/student-portal/POSTFLIGHT_0020.md` |
| `0021_access_schedule_v1.sql` | #1194 (aplicada e verificada em produção em 27/09/2026, versão `20260927100854`). Agendamentos de acesso: aceita o campo `accessSchedule` (Abrir/Fechar agendados por escola, turma ou aluno, salvos junto com `accessEnabled`). Aditiva e sem semente: sem linha, o nível segue a janela de acesso do Calendário. Aplicada depois do deploy do Worker da #1194. Evidência: `docs/student-portal/POSTFLIGHT_0021.md` |
| `0022_shift_policy_v1.sql` | #1201: políticas por turno da Relação, com prioridade Aluno > Turno > Turma > Escola. Acrescenta a view privada de turmas, aceita o escopo de turno e alinha a aprovação automática de publicações, preservando regras existentes. Aplicada como `20260928092734` antes do Worker compatível; evidência em `docs/student-portal/POSTFLIGHT_0022.md`. Contrato: `docs/student-portal/SHIFT_POLICY_V1.md`; publicação acompanhada na #1201. |
| `0023_audit_detail_v1.sql` | Motivos de recusa e detalhes de entrada na auditoria (pedido do responsável em 29/09/2026): coluna opcional `detail_json`, objeto pequeno e limitado (motivo, etapa, contadores de tentativa, "manter conectado" e família do dispositivo). Aditiva, sem backfill; aplicar antes do Worker que grava o campo. |
| `0024_seal_count_cache_v1.sql` | #1221: totais derivados privados por conta, com fingerprint de validade, datas e remoção em cascata; RLS e DML restrito à aplicação. Aplicada como `20261001201546`; evidência em `docs/student-portal/POSTFLIGHT_0024.md`. Sem alteração de notas ou políticas. |
| `0025_reconciliation_credentials_v1.sql` | #1269 / contrato #1276: candidata, não aplicada em produção. Leitor canônico de nascimento, transição dos acessos existentes e ponte privada de preparação/ativação atômica de PIN; depende de Gradebook 0015 e precede Gradebook 0016. Execução produtiva exige autorização posterior. |
| `0026_publication_source_retention_v1.sql` | Pedido do responsável em 14/10/2026: `prune_publication_source_v1()` remove de `publication_source_v2` as edições que nenhum alvo de publicação alcança (aprovação legada, liberações por escopo, pino da atualização automática e head), com os locks da preparação; `EXECUTE` só para `student_portal_app`, chamada pela manutenção agendada às 00:00 de Brasília. Aplicada como `20261014135534`. Sem alteração de publicação, política, conta ou nota. |
| `0027_frequency_policy_v1.sql` | Pedido do responsável em 20/10/2026: política **Frequência** (`showFrequency`), editável por escola, turno, turma e aluno. Aditiva e sem semente: sem linha, a frequência fica oculta no Portal e `/api/student/frequency` recusa a leitura. Aplicada como `20261020115021` antes do Worker que grava o campo; evidência em `docs/student-portal/POSTFLIGHT_0027.md`. |
| `0028_schedule_policy_v1.sql` | Decisão do responsável em 22/10/2026: política **Horário** (`showSchedule`), editável por escola, turno, turma e aluno. Aditiva e sem semente: sem linha, a aba Horário fica oculta e `/api/student/schedule` recusa a leitura. Aplicar antes do Worker que grava o campo. |
| `0029_school_calendar_v1.sql` | Decisão do responsável em 22/10/2026: **Calendário escolar**, com os dias letivos, feriados, recessos e eventos do ano, um para a escola inteira, editado no ADM (Políticas → Calendário), nunca com mais de 200 dias letivos. Aditiva, com semente do calendário oficial de 2026 (versão 1). Aplicada como `20261023082358`. |
| `0030_school_bells_v1.sql` | Decisão do responsável em 23/10/2026: **Horário das aulas**, com a hora de cada aula e do intervalo por turno e dia da semana, uma para a escola inteira, editada no ADM (Políticas → Horário) com versão e auditoria. Aditiva, com semente das folhas "Horário Matutino / Vespertino 2026 — 22/06" (versão 1). Aplicada como `20261023101824`. |
| `0031_school_bells_parada_v1.sql` | Decisão do responsável em 23/10/2026: a **parada** (ordem unida) nos horários, antes das aulas e, na sexta à tarde, depois da última até 18:00. Só atualiza os horários gravados pela 0030 enquanto ainda são exatamente os dela (versão 1, nunca editados no ADM); a nova versão é gravada pelo sistema. |

The ledger above is the **repository migration sequence**, not independent proof that every file has been applied remotely. Production application is recorded by the owning issue/deploy evidence and by the canonical project state. The sequence began against the Gradebook catalog through `migrations/gradebook-simplified/0008_year_reset_acl_v1.sql`; later Portal migrations declare newer Gradebook dependencies explicitly (for example `0012` depends on Gradebook `0009`). `gradebook.aluno(id, ano)` must remain unique and `gradebook.fechamento.rec_rr_mask` must exist. #705 must compare the target catalog and migration ledger before applying anything remotely. A `0019` foi aplicada em operação destrutiva separada e autorizada após o deploy do Worker sem leitura legada; o registro e as verificações estão em `docs/student-portal/POSTFLIGHT_0019.md`.

## Invariants

- Portal V1 is restricted to academic year 2026.
- A live Portal link is unique by `(academic_year, gradebook_student_id)` and references `gradebook.aluno(id, ano)` with `RESTRICT`, never cascade.
- Closing a link first writes `link_closure`, then nulls the live academic reference. The tombstone deliberately has no FK to Gradebook so history survives a later authorized Gradebook reset. Relinking by name is outside the contract.
- QR payloads, raw session tokens, PINs and passwords are never stored. Only credential metadata, verifiers and hashes are persisted.
- `student_portal_app` owns no schema objects and has no DDL, superuser or BYPASSRLS capability. It receives only runtime DML in the private Portal schema and SELECT on the narrow Portal-owned academic views. Desde #859, as 27 tabelas privadas também exigem a policy `student_portal_app_backend_v1`; a policy não concede operações e a ACL continua sendo o limite de SELECT/INSERT/UPDATE/DELETE.
- `PUBLIC` receives no schema/table/function privileges. Supabase client roles are not granted privileges by these migrations.
- `gradebook_app` receives schema `USAGE` and no table DML in `student_portal`. Across the current 0001–0015 chain it has `EXECUTE` exactly on `record_gradebook_change_v1`, `inspect_year_reset_guard_v1`, `ensure_year_coordination_v1`, `prepare_year_reset_v1`, `consume_year_reset_v1`, `complete_year_reset_v1` and `synchronize_gradebook_profiles_v1`. The narrower two-function state belongs only to the historical 0001–0004 checkpoint.
- Revision generations are random per database and counters are positive/durable. `record_gradebook_change_v1` is idempotent by `event_id` and must be called only after the #703 common lock protocol has been acquired by the writer. `inspect_year_reset_guard_v1` is read-only and must run in the same reset transaction after those locks.
- D1/KV are not fallback persistence for this schema.

## Application and rollback

#704 authors and tests these files only. It does **not** apply them to Supabase. #705 owns remote application/Hyperdrive/driver proof after this branch is integrated.

These migrations intentionally fail on replay against an existing `student_portal` schema rather than silently resetting it. Through `0018`, code rollback must remain compatible with the additive schema. `0019` deliberately dropped the legacy projection and its rows; reverting code cannot restore them. Do not reapply its SQL or restore the legacy reader as a code rollback.

# Reconciliação documental do histórico Supabase

Revisão de 11/10/2026. Projeto `knzzyqgafdkwzjmdrfea`; repositório `mcpmieda/ecossistema-escola`.
Base conferida: `17e82f62b35b3ed2cc998b694adfc6b7f3b249fb`. A revisão atualiza a PR #1273 somente com documentação. Não autoriza merge, alteração de banco/ledger, credenciais, segurança, integração ou deploy. Trabalhos #1268/#1269 preservados.

## Resultado

O inventário continua com **54 pares version/name**. Foram identificadas **43 fontes canônicas candidatas no Git** e **11 eventos sem arquivo exato**. A expressão “43 associações comprovadas” deve ser entendida como identificação das fontes documentais, nunca como 43 provas de SQL executado.

A comparação dos digests refinou as 43 associações:

| Nível | Quantidade | Evidência e limite |
|---|---:|---|
| H | 19 | SHA-256 bruto do arquivo Git coincide com o único statement registrado no ledger. Prova de igualdade do conteúdo registrado, sem atestado independente de execução/autenticidade histórica do ledger. |
| T | 10 | SHA-256 coincide depois de remover apenas espaço, tab, CR e LF nas bordas. Bytes brutos diferentes; conteúdo interno igual sob esse critério. |
| B | 12 | Fonte documental/nominal identificada, mas digests brutos e após trim diferem. Não declarar equivalência de SQL nem drift funcional apenas por isso. |
| N | 2 | Fonte documental identificada; `statements IS NULL` no ledger. Não há conteúdo remoto para conferir. |
| D | 11 | Sem arquivo original identificado. Classificação do evento refinada por indicadores/identificadores sanitizados, sem recuperação de corpos sensíveis. |

Entre as 12 B, três diferenças de representação foram explicadas por transformações delimitadas:
- `20260909160930`: remoção dos comentários de linha iniciais do arquivo 0002, seguida de trim.
- `20260927100854` e `20260929071319`: remoção dos comentários de linha iniciais e do BEGIN/COMMIT externo, seguida de trim.
Os digests transformados coincidem; as duas últimas diferenças não comprovam que o mecanismo remoto tenha preservado a mesma atomicidade. As três continuam B, para evitar tratar transformação como identidade bruta.

As duas N são `20260922150000` (Portal 0016) e `20260922150001` (Portal 0017). O README registra explicitamente essas versões. Não inferir por que statements está ausente nem reparar o ledger para preenchê-lo.

## Método verificável e sanitização

1. Leitura de version/name e metadados do ledger, sem SELECT de linhas acadêmicas, created_by, idempotency_key ou rollback.
2. Para as 49 versões não relacionadas a rotação, cálculo de SHA-256 em PostgreSQL de `array_to_string(statements, E'\\n')`, bytes e cardinalidade. Todas com conteúdo têm cardinalidade 1; as duas N têm NULL. Corpos históricos não foram retornados.
3. Nas cinco rotações, apenas version/name, cardinalidade, identificador da role e indicadores booleanos ALTER ROLE/PASSWORD. Nenhum corpo, valor, tamanho ou hash de credencial coletado.
4. Leitura das 43 fontes públicas fixadas ao SHA da base, cálculo de SHA-256 UTF-8 e comparação bruta/trim. O Node crypto confirmou independentemente os 43 hashes locais.
5. Histórico Git consultado para os 22 caminhos inicialmente divergentes com conteúdo: 19 têm uma revisão listada; três têm duas revisões. As seis revisões desses três caminhos foram comparadas; nenhuma trouxe igualdade bruta/trim. A consulta não é exaustiva de todos os caminhos apagados, forks ou branches.
6. Pesquisas dos seis nomes não relacionados a rotação e de `gradebook_phase2_ddl_review.sql` não localizaram fonte exata no Git consultado. Uma busca vazia não prova inexistência absoluta.
7. Evidências da issue #613 foram avaliadas como registros históricos, não como autorização operacional. Indicadores por expressão regular descrevem o texto registrado, não são um parser SQL nem prova independente de execução.

[migration-map.json](migration-map.json) contém, por linha, SHA-1 do blob Git, SHA-256 bruto/trim, bytes, nível, evidência e o que falta.
[review-evidence.json](review-evidence.json) preserva os resultados sanitizados e as comparações históricas, sem corpos SQL.
Não foram lidos inventários de credenciais anteriormente negados nem SQLs históricos de rotação. Nenhum SQL histórico foi publicado nesta PR.

## Investigação das 11 lacunas

A questão “qual era a operação?” ganhou evidência em todas as 11; a questão “qual arquivo imutável exato foi enviado?” permanece aberta.

| Versão | Evento | Identificadores registrados sanitizados | Evidência ainda ausente |
|---|---|---|---|
| 20260908153620 | rotate_gradebook_app_password_20260908_02 | gradebook_app | Arquivo de proveniência administrativa sanitizado; não recuperar valores antigos de senha. É seguro encerrar como evento administrativo legado sem fonte reaplicável. |
| 20260908153655 | rotate_gradebook_app_password_20260908_03 | gradebook_app | Arquivo de proveniência administrativa sanitizado; não recuperar valores antigos de senha. É seguro encerrar como evento administrativo legado sem fonte reaplicável. |
| 20260908160759 | rotate_gradebook_app_password_20260908_04 | gradebook_app | Arquivo de proveniência administrativa sanitizado; não recuperar valores antigos de senha. É seguro encerrar como evento administrativo legado sem fonte reaplicável. |
| 20260908160852 | rotate_gradebook_app_password_20260908_05 | gradebook_app | Arquivo de proveniência administrativa sanitizado; não recuperar valores antigos de senha. É seguro encerrar como evento administrativo legado sem fonte reaplicável. |
| 20260908162021 | rotate_gradebook_app_password_20260908_06 | gradebook_app | Arquivo de proveniência administrativa sanitizado; não recuperar valores antigos de senha. É seguro encerrar como evento administrativo legado sem fonte reaplicável. |
| 20260908213513 | reset_gradebook_for_simplified_rebuild | bn_benchmark, gradebook | Falta arquivo imutável/commit do SQL original de reset; baseline posterior não substitui sua origem. |
| 20260908230146 | grant_gradebook_app_access | GRANT registrado | Falta versão exata de SQL de grants original vinculada ao digest do ledger. application_role_grants.sql atual tem digest e tamanho diferentes. |
| 20260909001115 | defer_import_year_fk_for_atomic_first_relation | gradebook.importacao | Falta arquivo/commit exato do ALTER CONSTRAINT original vinculado ao digest do ledger; incorporação na baseline não prova igualdade de bytes. |
| 20260909020108 | create_simplified_gradebook_phase2 | gradebook, gradebook.aluno, gradebook.ano_letivo, gradebook.ano_letivo_historico, gradebook.conselho_anterior_historico, gradebook.conselho_decisao, gradebook.conselho_decisao_historico, gradebook.disciplina, gradebook.fechamento, gradebook.fechamento_historico, gradebook.importacao, gradebook.instrumento, gradebook.instrumento_historico, gradebook.nota, gradebook.nota_historico, gradebook.oferta, gradebook.professor, gradebook.turma, gradebook.vinculo, gradebook.vinculo_historico | Falta gradebook_phase2_ddl_review.sql original, imutável e sanitizado, com hash correspondente; a issue cita o arquivo mas ele não foi encontrado na árvore/search Git consultados. |
| 20260912150002 | student_portal_runtime_connection_budget_v1 | student_portal_app | Falta registro imutável do artefato administrativo original vinculado ao digest; configuração atual da role não comprova o evento histórico. |
| 20260922074718 | prepare_sharepoint_profile_photo_storage | student_portal.profile_photo | Falta artefato original de preparação de profile_photo ligado ao digest; migrations de fotos posteriores não são substitutas. |

Evidência complementar:
- [Fase 2 concluída e grants](https://github.com/mcpmieda/ecossistema-escola/issues/613#issuecomment-5594704683): documenta 19 tabelas, aplicação dos dois nomes e ACL da role; não fornece bytes/hash do artefato original.
- [FK diferida](https://github.com/mcpmieda/ecossistema-escola/issues/613#issuecomment-5595260550): documenta `importacao_ano_fk` como DEFERRABLE INITIALLY DEFERRED e a finalidade atômica; não fornece arquivo/hash do SQL enviado.
- [Versão da fase 2 e arquivo de revisão citado](https://github.com/mcpmieda/ecossistema-escola/issues/613#issuecomment-5607003053): liga `20260909020108` à fase 2 e cita `gradebook_phase2_ddl_review.sql`. O reset de dados descrito nesse comentário é posterior e não deve ser confundido com a migration de reset inicial.
- O ledger registra DROP SCHEMA/CASCADE e os identificadores `gradebook`/`bn_benchmark` no reset inicial; ALTER TABLE/DEFERRABLE na FK; CREATE TABLE/FUNCTION na fase 2; ALTER ROLE/CONNECTION LIMIT no orçamento; e CREATE/ALTER TABLE/GRANT com `student_portal.profile_photo` na preparação de fotos.
- `0001_current_schema.sql` tem SHA-256 `8c7a1960112cffe7a9d41ca125af7a62b27247123b549e5e26f3b4420cf8fc95`, diferente do statement fase 2. `application_role_grants.sql` tem SHA-256 `05ce99ad6e2f8f2c152c20782d2a4b7477be6510f152f80beebd6f88932ffea6`, diferente do grant histórico. Essas fontes não são substitutas exatas.

## Alternativa segura para encerrar sem fabricar histórico

Encerrar esta etapa como **inventário e auditoria documental concluídos, com proveniência incompleta declarada**. Preservar os 54 registros; não criar migrations vazias, não atribuir timestamps fictícios, não reconstruir SQL de senhas, não trocar eventos por uma baseline e não chamar a reconciliação automática de concluída.

- Rotações e orçamento: manter como operações administrativas legadas sem artefato reaplicável. Evidência futura deve ser sanitizada, sem recuperação dos valores antigos.
- Reset inicial: registrar como destrutivo e não reaplicável; não existe rollback de dados por reverter código/ledger.
- Fase 2 e FK: registrar a origem documental e os passos absorvidos pela baseline; validar somente precondições do catálogo atual para uma mudança nova.
- Grant: preservar a história incompleta; avaliar ACL atual e qualquer delta novo em escopo próprio, sem replay do grant antigo.
- Fotos: registrar a preparação histórica de profile_photo; não confundi-la com student-photos/0005, adoção administrativa ou a arquitetura atual de Storage.
A aceitação dessas lacunas documentais não equivale a autorizar uma mutação operacional. [Plano futuro](APPROVAL_PLAN.md).

## Baselines e passos que não podem virar replay

O README do Banco simplificado define `0001_current_schema.sql` como fotografia posterior do catálogo: `0002_import_diagnostics_audit_v1.sql` e a FK diferida já estão incorporadas. Não executar 0002 depois de 0001 nem executar 0001 contra o schema existente.
As fontes Postgres anteriores pertencem ao modelo legado; não restaurar streams/versions.
Gradebook 0003–0005 possuem documentação produtiva, mas não há registros separados com esses nomes entre os 54. Isso não prova ausência dos objetos atuais nem permite atribuí-las a outra versão.
Portal 0019 é destrutiva; rollback de código não restaura sua projeção apagada. Fotos 0001–0004 e identidade 0018 são documentadas como já aplicadas. Supplement de índices e application_role_grants são reconstrução/ACL, não entradas automaticamente associadas ao ledger.

## Cache 0024 e integração

A versão `20261001201546` permanece presente e o espelho `20261001224416` ausente. A fonte 0024 é nível T nesta comparação: digest bruto do arquivo `b1c21836a95f9c721e39c663fae37d71aa6469fc4579d8beb05dfd1b237561a9`; digest bruto registrado `b0b032a3904375777b34783e93920c6e7eb37b747309ead718cfb44f8e41f918`; coincidência depois de trim. Não confundir o hash documental do arquivo/espelho com o hash bruto do statement armazenado.

A inspeção anterior desta tarefa confirmou seal_count_cache_v1 existente, owner postgres, RLS ligada, force RLS desligada e ACL direta postgres/student_portal_app. Não foi auditoria de memberships nem de todo o banco.
[Postflight 0024](https://github.com/mcpmieda/ecossistema-escola/blob/17e82f62b35b3ed2cc998b694adfc6b7f3b249fb/docs/student-portal/POSTFLIGHT_0024.md) e [pós-deploy 1272](https://github.com/mcpmieda/ecossistema-escola/pull/1272#issuecomment-6104768095).

Deploy to production OFF permanece sem alteração. A confirmação histórica foi salva após reload em 11/10 às 02:45 UTC; o Dashboard não foi reconfirmado nesta rodada. O ledger não revela esse setting. A integração permanece fora desta entrega.

## Revisão e validação

Comentários recentes consultados antes da atualização: CodeRabbit pulou revisão por ser draft; SonarCloud informou Quality Gate Passed. Nenhum deles autorizou operações nem comprovou a origem dos SQLs.
[Validação isolada e limites](VALIDATION.md): metadados/digests e modelo de seleção futura passaram localmente. Ensaio PostgreSQL 18.6 iniciou em loopback, mas psql foi bloqueado por permissão 10013 antes de qualquer SQL; não houve contorno. Produção informa PostgreSQL 17.6. Não declarar validação de DDL, RLS/ACL, atomicidade do conector ou schema produtivo por esse ensaio.
Os gates nativos existentes passaram no head documental anterior; sua cobertura de código/schema existente não valida uma migration futura ainda inexistente. Os resultados e SHAs estão no documento de validação.
A leitura do checkout físico permanece bloqueada por ACL, sem escalada.

## Mapa completo

| Versão | Nome remoto | Fonte candidata / lacuna | Nível |
|---|---|---|---|
| 20260907172144 | bn_benchmark_v1 | migrations/postgres/0001_bn_benchmark_v1.sql | B |
| 20260908103626 | gradebook_production_v1 | migrations/postgres/0002_gradebook_production_v1.sql | H |
| 20260908153620 | rotate_gradebook_app_password_20260908_02 | sem arquivo exato | D |
| 20260908153655 | rotate_gradebook_app_password_20260908_03 | sem arquivo exato | D |
| 20260908160759 | rotate_gradebook_app_password_20260908_04 | sem arquivo exato | D |
| 20260908160852 | rotate_gradebook_app_password_20260908_05 | sem arquivo exato | D |
| 20260908162021 | rotate_gradebook_app_password_20260908_06 | sem arquivo exato | D |
| 20260908213513 | reset_gradebook_for_simplified_rebuild | sem arquivo exato | D |
| 20260908230146 | grant_gradebook_app_access | sem arquivo exato | D |
| 20260909001115 | defer_import_year_fk_for_atomic_first_relation | sem arquivo exato | D |
| 20260909020108 | create_simplified_gradebook_phase2 | sem arquivo exato | D |
| 20260909160930 | add_simplified_import_diagnostics_audit | migrations/gradebook-simplified/0002_import_diagnostics_audit_v1.sql | B |
| 20260911140219 | import_diagnostic_treatment_v1 | migrations/gradebook-simplified/0006_import_diagnostic_treatment_v1.sql | B |
| 20260911201622 | multiyear_rr_v1 | migrations/gradebook-simplified/0007_multiyear_rr_v1.sql | T |
| 20260912004843 | year_reset_acl_v1 | migrations/gradebook-simplified/0008_year_reset_acl_v1.sql | T |
| 20260912141718 | student_portal_0001_identity_credentials_acl_v1 | migrations/student-portal/0001_identity_credentials_acl_v1.sql | H |
| 20260912141723 | student_portal_0002_policy_publication_revision_v1 | migrations/student-portal/0002_policy_publication_revision_v1.sql | H |
| 20260912141729 | student_portal_0003_audit_receipts_closure_integration_v1 | migrations/student-portal/0003_audit_receipts_closure_integration_v1.sql | H |
| 20260912141733 | student_portal_0004_gradebook_integration_usage_v1 | migrations/student-portal/0004_gradebook_integration_usage_v1.sql | H |
| 20260912150002 | student_portal_runtime_connection_budget_v1 | sem arquivo exato | D |
| 20260912165146 | year_reset_protocol_v1 | migrations/student-portal/0005_year_reset_protocol_v1.sql | B |
| 20260912173924 | gradebook_revision_year_range_v1 | migrations/student-portal/0006_gradebook_revision_year_range_v1.sql | T |
| 20260912182516 | lifecycle_integration_v1 | migrations/student-portal/0007_lifecycle_integration_v1.sql | T |
| 20260914235006 | student_portal_atomic_publication_v2 | migrations/student-portal/0008_atomic_publication_v2.sql | T |
| 20260914235035 | student_portal_publication_cutover_guard_v2 | migrations/student-portal/0009_publication_cutover_guard_v2.sql | H |
| 20260915102433 | student_portal_incremental_publication_v3 | migrations/student-portal/0010_incremental_publication_v3.sql | H |
| 20260915164741 | student_portal_live_event_outbox_v1 | migrations/student-portal/0011_live_event_outbox_v1.sql | T |
| 20260916090209 | granular_observations_names_v1 | migrations/gradebook-simplified/0009_granular_observations_names_v1.sql | B |
| 20260916090215 | student_portal_granular_observations_names_v1 | migrations/student-portal/0012_granular_observations_names_v1.sql | B |
| 20260916200845 | student_portal_publication_inheritance_v1 | migrations/student-portal/0013_publication_inheritance_v1.sql | T |
| 20260918114401 | gradebook_rls_v1 | migrations/gradebook-simplified/0011_gradebook_rls_v1.sql | H |
| 20260918115606 | qualitative_corrections_2026_v1 | migrations/gradebook-simplified/0010_qualitative_corrections_2026_v1.sql | H |
| 20260918163014 | current_state_cleanup_v1 | migrations/gradebook-simplified/0012_current_state_cleanup_v1.sql | H |
| 20260918173558 | year_reset_full_cleanup_v1 | migrations/student-portal/0014_year_reset_full_cleanup_v1.sql | H |
| 20260920004859 | student_portal_rls_v1 | migrations/student-portal/0015_student_portal_rls_v1.sql | T |
| 20260920162250 | default_privileges_hardening_v1 | migrations/gradebook-simplified/0013_default_privileges_hardening_v1.sql | B |
| 20260921211119 | system_health_history_1091_v1 | migrations/observability/0001_portal_health_history_v1.sql | H |
| 20260921222305 | portal_signals_1093_v1 | migrations/observability/0002_portal_signals_v1.sql | H |
| 20260922074718 | prepare_sharepoint_profile_photo_storage | sem arquivo exato | D |
| 20260922150000 | student_portal_audit_entities_v1 | migrations/student-portal/0016_audit_entities_v1.sql | N |
| 20260922150001 | student_portal_security_event_priority_v1 | migrations/student-portal/0017_security_event_priority_v1.sql | N |
| 20260922212633 | student_portal_shared_student_identity_v1 | migrations/student-portal/0018_shared_student_identity_v1.sql | H |
| 20260923164053 | student_portal_remove_legacy_projection_v1 | migrations/student-portal/0019_remove_legacy_projection_v1.sql | B |
| 20260923172851 | student_photos_private_delivery_v1 | migrations/student-photos/0001_private_delivery_v1.sql | H |
| 20260923172918 | student_photos_write_journal_v1 | migrations/student-photos/0002_write_journal_v1.sql | H |
| 20260923191611 | student_photos_runtime_catalog_v1 | migrations/student-photos/0003_runtime_catalog_v1.sql | H |
| 20260923191702 | student_photos_resumable_payload_v1 | migrations/student-photos/0004_resumable_payload_v1.sql | H |
| 20260923193137 | student_portal_term_closing_policy_v1 | migrations/student-portal/0020_term_closing_policy_v1.sql | B |
| 20260923224615 | student_photos_supabase_storage_v1 | migrations/student-photos/0005_supabase_storage_v1.sql | T |
| 20260927100854 | student_portal_access_schedule_v1 | migrations/student-portal/0021_access_schedule_v1.sql | B |
| 20260928092734 | student_portal_shift_policy_v1 | migrations/student-portal/0022_shift_policy_v1.sql | B |
| 20260929071319 | student_portal_audit_detail_v1 | migrations/student-portal/0023_audit_detail_v1.sql | B |
| 20261001201546 | student_portal_seal_count_cache_v1 | migrations/student-portal/0024_seal_count_cache_v1.sql | T |
| 20261005151011 | function_execute_hardening_v1 | migrations/gradebook-simplified/0014_function_execute_hardening_v1.sql | H |

## Fontes canônicas

- [AGENTS.md](https://github.com/mcpmieda/ecossistema-escola/blob/17e82f62b35b3ed2cc998b694adfc6b7f3b249fb/AGENTS.md), blob caad264b30f12a5ea16f705a2b626621d93312ad.
- [README migrations](https://github.com/mcpmieda/ecossistema-escola/blob/17e82f62b35b3ed2cc998b694adfc6b7f3b249fb/migrations/README.md).
- [Baseline simplificada](https://github.com/mcpmieda/ecossistema-escola/blob/17e82f62b35b3ed2cc998b694adfc6b7f3b249fb/migrations/gradebook-simplified/README.md).
- [Portal](https://github.com/mcpmieda/ecossistema-escola/blob/17e82f62b35b3ed2cc998b694adfc6b7f3b249fb/migrations/student-portal/README.md).
- [Fotos](https://github.com/mcpmieda/ecossistema-escola/blob/17e82f62b35b3ed2cc998b694adfc6b7f3b249fb/migrations/student-photos/README.md).

Nenhuma mutation de produção, repair, replay, credencial, permissão, configuração, deploy ou merge foi executada. A PR é somente documentação; a etapa documental pode ser revisada com as lacunas visíveis.

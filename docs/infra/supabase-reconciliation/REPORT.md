# Reconciliação documental do histórico Supabase — 11/10/2026

Projeto: knzzyqgafdkwzjmdrfea. Repositório: mcpmieda/ecossistema-escola.
Main consultada pelo conector GitHub: 17e82f62b35b3ed2cc998b694adfc6b7f3b249fb.
Árvore consultada integralmente, truncated=false. AGENTS.md lido no SHA fixado (blob caad264b30f12a5ea16f705a2b626621d93312ad); nenhum SKILL.md adicional localizado nessa árvore. Skill Supabase lida.
Escopo autorizado: publicar esta documentação em PR em rascunho para revisão. Mudanças no banco, ledger, configurações, permissões, migrations executáveis, deploy e merge não estão autorizadas.

## Resultado e limites

Revalidação para publicação: main permanece em `17e82f62b35b3ed2cc998b694adfc6b7f3b249fb`; os 54 pares version/name coincidem exatamente com o inventário inicial, após comparação ordenada por versão e nome.

54 versões remotas consultadas via list_migrations; 43 associações a arquivos canônicos identificados no Git, 11 sem SQL exato. As associações comprovam a identificação documental das fontes, com os limites de certeza abaixo.
A associação por nome, caminho e documentação NÃO demonstra identidade dos bytes executados. Não foram consultados statements do ledger, SQLs de rotação, inventários de credenciais nem dados pessoais.
Hashes Git blob SHA-1 identificam a revisão do arquivo na árvore fixada; não são SHA256 do SQL remoto.
Histórico Git de migrations consultado em duas páginas (104 commits, metadados); não é uma busca exaustiva de todos os arquivos apagados, branches e discussões. Lacunas continuam abertas.

A preparação utilizou o conector GitHub autorizado. O checkout físico não pôde ser lido por restrição de ACL; não houve contorno. Os trabalhos 1268/1269 permanecem preservados.

Deploy to production OFF: confirmação histórica em comentário 6104768095 (salvo e persistido após reload em 11/10 às 02:45 UTC). Não foi alterado; valor atual não foi reconfirmado no Dashboard nesta tarefa. Não inferir estado atual de settings pelo ledger.

## Cache 0024 e evidência

Versão 20261001201546 presente; espelho 20261001224416 ausente. Fonte canônica migrations/student-portal/0024_seal_count_cache_v1.sql, blob e03b1e0a0c209d66bae201c02ababa0f4a3163e0.
Postflight documenta SHA256 B1C21836A95F9C721E39C663FAE37D71AA6469FC4579D8BEB05DFD1B237561A9 para canônica e espelho histórico.
Consulta atual somente catálogo: student_portal.seal_count_cache_v1 existente, owner postgres, relrowsecurity=true, relforcerowsecurity=false; ACL direta {postgres=arwdDxtm/postgres,student_portal_app=arw/postgres}. Isso não verifica memberships ou privilégios herdados de todo o banco.
Comentário pós-deploy registra comparação exata de 54 pares e ACL/RLS. A consulta atual confirma os pares e metadados diretos da tabela, sem alegar auditoria global.

## Classificação e baselines

- Cinco rotações: operações administrativas históricas, somente version/name. Nunca reconstruir senhas nem copiar SQL de rotação para replay.
- Reset simplificado: destrutivo; baseline posterior não é seu SQL original nem recuperação de dados.
- Grant: application_role_grants.sql é fonte contextual, não identidade comprovada do evento grant_gradebook_app_access.
- FK diferida: README confirma incorporação na baseline 0001. Não inventar arquivo separado para o evento remoto.
- Fase 2: sem arquivo exato; baseline de 10/09 é fotografia posterior do catálogo. Não atribuir extensões posteriores à fase 2.
- Orçamento runtime: operação administrativa, sem SQL exato identificado.
- Preparação SharePoint/fotos: operação histórica distinta de student-photos/0005 e da adoção posterior.
- Gradebook-simplified/0001_current_schema.sql: baseline não reaplicável sobre schema existente. 0002 já incorporada; mantém memória do passo original.
- Postgres/0001 e 0002: esquemas históricos anteriores; não restaurar streams/versions sobre modelo simplificado.
- Gradebook 0003–0005 existem no Git e têm evidências produtivas nos READMEs, mas não há pares remotos separados com esses nomes nos 54. Não fabricar timestamps, nem declarar que estão ausentes do schema.
- Supplement current_cross_schema_indexes_v1.sql e grants são reconstrução/ACL, sem associação automática a ledger.
- Portal 0019 é destrutiva; rollback de código não restaura linhas removidas. Fotos 0001–0004 e identidade 0018 estão documentadas como já aplicadas: não repetir.

## Níveis de certeza

A: versão vinculada explicitamente no postflight com evidência documental e hash. Não equivale a comparação do corpo SQL remoto.
B: associação nominal/contextual consistente a fonte canônica identificada por blob Git; application bytes não demonstrados.
D: arquivo exato ausente; hipótese contextual explicitamente separada.
Os JSONs contêm a categoria, observação e nível por versão.

## Mapa completo

| Versão | Nome remoto | SQL canônico / lacuna | Certeza | Git blob SHA-1 |
|---|---|---|---|---|
| 20260907172144 | bn_benchmark_v1 | migrations/postgres/0001_bn_benchmark_v1.sql | B | 05a23c049f68d518fda7b53d84d856b763f96c13 |
| 20260908103626 | gradebook_production_v1 | migrations/postgres/0002_gradebook_production_v1.sql | B | 5281daff7abbd2594951b136c23527b39702a9f2 |
| 20260908153620 | rotate_gradebook_app_password_20260908_02 | Somente version/name consultados; corpo e valores de rotação não lidos. | D | — |
| 20260908153655 | rotate_gradebook_app_password_20260908_03 | Somente version/name consultados; corpo e valores de rotação não lidos. | D | — |
| 20260908160759 | rotate_gradebook_app_password_20260908_04 | Somente version/name consultados; corpo e valores de rotação não lidos. | D | — |
| 20260908160852 | rotate_gradebook_app_password_20260908_05 | Somente version/name consultados; corpo e valores de rotação não lidos. | D | — |
| 20260908162021 | rotate_gradebook_app_password_20260908_06 | Somente version/name consultados; corpo e valores de rotação não lidos. | D | — |
| 20260908213513 | reset_gradebook_for_simplified_rebuild | Reset destrutivo de reconstrução; baseline 0001 é fotografia posterior, não o SQL exato do reset. | D | — |
| 20260908230146 | grant_gradebook_app_access | application_role_grants.sql é candidato contextual; grants/defaults posteriores podem diferir. Sem equivalência exata. | D | — |
| 20260909001115 | defer_import_year_fk_for_atomic_first_relation | README da baseline confirma FK DEFERRABLE INITIALLY DEFERRED incorporada em 0001; SQL produtivo original não identificado. | D | — |
| 20260909020108 | create_simplified_gradebook_phase2 | Reconstrução anterior à baseline 0001 de 10/09; relações posteriores 0003–0005 não devem ser atribuídas a este passo sem prova. | D | — |
| 20260909160930 | add_simplified_import_diagnostics_audit | migrations/gradebook-simplified/0002_import_diagnostics_audit_v1.sql | B | 94be41daf0a6dd2ea19eb12007aca98a5dd71b08 |
| 20260911140219 | import_diagnostic_treatment_v1 | migrations/gradebook-simplified/0006_import_diagnostic_treatment_v1.sql | B | f8b246ae87b59038436a7f04e04a9af82388ed52 |
| 20260911201622 | multiyear_rr_v1 | migrations/gradebook-simplified/0007_multiyear_rr_v1.sql | B | 70dadc0f314c8c6b089128fb5900a1398ac9461f |
| 20260912004843 | year_reset_acl_v1 | migrations/gradebook-simplified/0008_year_reset_acl_v1.sql | B | 0d78ff42b8721367aa516629cc9f276941e15365 |
| 20260912141718 | student_portal_0001_identity_credentials_acl_v1 | migrations/student-portal/0001_identity_credentials_acl_v1.sql | B | 8054454ed34d2a29cf550708fecc79111cb96f19 |
| 20260912141723 | student_portal_0002_policy_publication_revision_v1 | migrations/student-portal/0002_policy_publication_revision_v1.sql | B | 4cc32abd6146aed9956156ff050f596d40cbd447 |
| 20260912141729 | student_portal_0003_audit_receipts_closure_integration_v1 | migrations/student-portal/0003_audit_receipts_closure_integration_v1.sql | B | d838306e083cc209346bc233a7918d5c8bfed411 |
| 20260912141733 | student_portal_0004_gradebook_integration_usage_v1 | migrations/student-portal/0004_gradebook_integration_usage_v1.sql | B | 0b896b35405fed24920c92cac8d108eec922c687 |
| 20260912150002 | student_portal_runtime_connection_budget_v1 | Operação administrativa de orçamento/conexões; sem arquivo SQL canônico identificado. Não inferir ALTER ROLE nem valores. | D | — |
| 20260912165146 | year_reset_protocol_v1 | migrations/student-portal/0005_year_reset_protocol_v1.sql | B | 2925b38bf3d9ed8751fc8605b6cfde54ce7e7a46 |
| 20260912173924 | gradebook_revision_year_range_v1 | migrations/student-portal/0006_gradebook_revision_year_range_v1.sql | B | 0da9602791b1f8d37d4ff360988158c0e6b8004f |
| 20260912182516 | lifecycle_integration_v1 | migrations/student-portal/0007_lifecycle_integration_v1.sql | B | 3cc62d0d5488721565afdbf47ed31841b7b8c9b6 |
| 20260914235006 | student_portal_atomic_publication_v2 | migrations/student-portal/0008_atomic_publication_v2.sql | B | 70ad3b5c3d4d976db37570159e1ffc3cba4e28b0 |
| 20260914235035 | student_portal_publication_cutover_guard_v2 | migrations/student-portal/0009_publication_cutover_guard_v2.sql | B | bc8d965c94f7fdf82dc291d5a2eca8383fddfeee |
| 20260915102433 | student_portal_incremental_publication_v3 | migrations/student-portal/0010_incremental_publication_v3.sql | B | aadd570a3738f6c860731fe33fd8a92b9acedc30 |
| 20260915164741 | student_portal_live_event_outbox_v1 | migrations/student-portal/0011_live_event_outbox_v1.sql | B | 36a7b160213d6dd700199486a12be0b24c5b88a9 |
| 20260916090209 | granular_observations_names_v1 | migrations/gradebook-simplified/0009_granular_observations_names_v1.sql | B | 854106bdb5ede9afd78825a0e18a787c978454ee |
| 20260916090215 | student_portal_granular_observations_names_v1 | migrations/student-portal/0012_granular_observations_names_v1.sql | B | d007d476ef296d2cb995fda78b827e8632c2bfb7 |
| 20260916200845 | student_portal_publication_inheritance_v1 | migrations/student-portal/0013_publication_inheritance_v1.sql | B | 67668d8cd567efad1f59983572e2e5a107b6aff0 |
| 20260918114401 | gradebook_rls_v1 | migrations/gradebook-simplified/0011_gradebook_rls_v1.sql | B | 07fa2eb2999ee2c7e598bcafeb1fdfeb0ac3f35a |
| 20260918115606 | qualitative_corrections_2026_v1 | migrations/gradebook-simplified/0010_qualitative_corrections_2026_v1.sql | B | 538b6a3238c1b7cbf970c8dc37c5c8ab52698c55 |
| 20260918163014 | current_state_cleanup_v1 | migrations/gradebook-simplified/0012_current_state_cleanup_v1.sql | B | ba9e461b0bfca5b53c4165c00b22ab0f0015a0e5 |
| 20260918173558 | year_reset_full_cleanup_v1 | migrations/student-portal/0014_year_reset_full_cleanup_v1.sql | B | 659a367ba905d240f70cab4d0398e33782f3e561 |
| 20260920004859 | student_portal_rls_v1 | migrations/student-portal/0015_student_portal_rls_v1.sql | B | fba7a92a8bbb07b3dde9913938ce983130bad7b2 |
| 20260920162250 | default_privileges_hardening_v1 | migrations/gradebook-simplified/0013_default_privileges_hardening_v1.sql | B | 50fe3151d4ef12e56cb5cc2f82db626fb986ebeb |
| 20260921211119 | system_health_history_1091_v1 | migrations/observability/0001_portal_health_history_v1.sql | B | 3ee4c63749dfe7c1c791a99749183d6ddba75519 |
| 20260921222305 | portal_signals_1093_v1 | migrations/observability/0002_portal_signals_v1.sql | B | 12dd355bb2c6420671394daf5f47d958ba281b25 |
| 20260922074718 | prepare_sharepoint_profile_photo_storage | Preparação histórica de fotos; não confundir com student-photos/0005 nem roteiro de adoção posterior. Sem SQL exato. | D | — |
| 20260922150000 | student_portal_audit_entities_v1 | migrations/student-portal/0016_audit_entities_v1.sql | B | f1cc90d6a9f0da6aecb1a560afa8b946b594bc68 |
| 20260922150001 | student_portal_security_event_priority_v1 | migrations/student-portal/0017_security_event_priority_v1.sql | B | 36153cb96ecb4cd74f38ca394c75cd6c4a16fbf4 |
| 20260922212633 | student_portal_shared_student_identity_v1 | migrations/student-portal/0018_shared_student_identity_v1.sql | B | 0e4c1f1298c6f69e5acf12f4ebe0464ea0ea97ab |
| 20260923164053 | student_portal_remove_legacy_projection_v1 | migrations/student-portal/0019_remove_legacy_projection_v1.sql | B | 54aef301d949cbe5da5de07977580722491563ad |
| 20260923172851 | student_photos_private_delivery_v1 | migrations/student-photos/0001_private_delivery_v1.sql | B | aec58b9608883041c0cef52b4a02a589adb6c783 |
| 20260923172918 | student_photos_write_journal_v1 | migrations/student-photos/0002_write_journal_v1.sql | B | 1facd11a96b81e33da679764f3ed979a20ec91df |
| 20260923191611 | student_photos_runtime_catalog_v1 | migrations/student-photos/0003_runtime_catalog_v1.sql | B | 6a3adcb1314f2b7f07465f06415110101ab8cddb |
| 20260923191702 | student_photos_resumable_payload_v1 | migrations/student-photos/0004_resumable_payload_v1.sql | B | 0ed11dad6248a9168c413adfee2f7c2e9b5fc12f |
| 20260923193137 | student_portal_term_closing_policy_v1 | migrations/student-portal/0020_term_closing_policy_v1.sql | B | ce016f7ba3ca338848c6a41d50a8d69621e87d37 |
| 20260923224615 | student_photos_supabase_storage_v1 | migrations/student-photos/0005_supabase_storage_v1.sql | B | 2d0077ed9d354d186b7f57a6fe551254200b53d5 |
| 20260927100854 | student_portal_access_schedule_v1 | migrations/student-portal/0021_access_schedule_v1.sql | B | 54b17d6898052b43be7329df594525e592725ccb |
| 20260928092734 | student_portal_shift_policy_v1 | migrations/student-portal/0022_shift_policy_v1.sql | B | 4f380b4942c6b5f48f88fd80f70d8c6acf43779a |
| 20260929071319 | student_portal_audit_detail_v1 | migrations/student-portal/0023_audit_detail_v1.sql | B | b3ddacf8a38848968dd64d4a8349765dcd870178 |
| 20261001201546 | student_portal_seal_count_cache_v1 | migrations/student-portal/0024_seal_count_cache_v1.sql | A | e03b1e0a0c209d66bae201c02ababa0f4a3163e0 |
| 20261005151011 | function_execute_hardening_v1 | migrations/gradebook-simplified/0014_function_execute_hardening_v1.sql | B | 77dcdba2cfbd2bd70b7a1007d3137ece7e2f59b9 |

## Fontes

- [Main consultada](https://api.github.com/repos/mcpmieda/ecossistema-escola/branches/main).
- [Árvore fixada](https://github.com/mcpmieda/ecossistema-escola/tree/17e82f62b35b3ed2cc998b694adfc6b7f3b249fb).
- [Evidência pós-deploy 1272](https://github.com/mcpmieda/ecossistema-escola/pull/1272#issuecomment-6104768095).
- [README migrations](https://github.com/mcpmieda/ecossistema-escola/blob/17e82f62b35b3ed2cc998b694adfc6b7f3b249fb/migrations/README.md).
- [Baseline simplificada](https://github.com/mcpmieda/ecossistema-escola/blob/17e82f62b35b3ed2cc998b694adfc6b7f3b249fb/migrations/gradebook-simplified/README.md).
- [Portal](https://github.com/mcpmieda/ecossistema-escola/blob/17e82f62b35b3ed2cc998b694adfc6b7f3b249fb/migrations/student-portal/README.md).
- [Postflight 0024](https://github.com/mcpmieda/ecossistema-escola/blob/17e82f62b35b3ed2cc998b694adfc6b7f3b249fb/docs/student-portal/POSTFLIGHT_0024.md).
- [Fotos](https://github.com/mcpmieda/ecossistema-escola/blob/17e82f62b35b3ed2cc998b694adfc6b7f3b249fb/migrations/student-photos/README.md).

A publicação autorizada consiste somente nesta documentação em PR em rascunho. Nenhuma operação de banco, ledger, migrations executáveis, settings, permissões, deploy ou merge integra a entrega. Nenhuma pasta de migrations foi povoada. As 11 lacunas permanecem sem solução; a reconciliação executável depende de evidência e autorização específica.


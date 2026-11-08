# Baseline relacional atual — #633

Esta pasta reconstrói o schema observado por inspeção **somente leitura** em 10/09/2026. Não executa uma migration de produção e não substitui um backup de dados.

## Arquivos

- `0001_current_schema.sql`: 20 tabelas (19 centrais + diagnóstico), 127 colunas, 123 constraints (34 FKs), 38 índices, 4 funções e **3 triggers distintos**. `information_schema.triggers` enumera 6 eventos porque cada trigger cobre INSERT e UPDATE. Inclui a FK de primeiro import `DEFERRABLE INITIALLY DEFERRED`, ausente no DDL inicial da reconstrução.
- `0002_import_diagnostics_audit_v1.sql`: migration histórica já refletida na reconstrução de `0001`; permanece como memória do passo produtivo original e **não** deve ser reaplicada depois da baseline atual.
- `0003_council_session_v3.sql`: extensão aditiva FINAL-3 #648 com sessão, idempotência, votação numérica, históricos e fotografias imutáveis do Conselho. Não faz backfill, não persiste presentes/desempate/diretor e não altera a autoridade acadêmica.
- `0004_council_v3_least_privilege.sql`: correção idempotente de ACL para neutralizar grants padrão do proprietário após `0003`; mantém somente as operações usadas pela role `gradebook_app` e não altera objetos ou dados.
- `0005_relational_bulletin_snapshot_v2.sql`: extensão aditiva #654 com snapshot imutável de boletim, FKs de 2026, checks de identidade JSON e ACL `SELECT, INSERT` para `gradebook_app`; sem backfill ou DML acadêmico.
- `0006_import_diagnostic_treatment_v1.sql`: extensão aditiva #674 com reconhecimento/anotação append-only separados do snapshot corrente, ator server-side e ACL `SELECT, INSERT`; sem backfill, resolução manual ou DML acadêmico. Aplicada em produção após autorização explícita e postflight.
- `0007_multiyear_rr_v1.sql`: extensão aditiva #676 que acrescenta a máscara terminal `R/R`, amplia os estados do histórico de fechamento e remove apenas os checks físicos que limitavam boletins/tratamentos a 2026. Sem backfill ou DML acadêmico; deve ser aplicada somente depois de `0003`–`0006` e do preflight autorizado.
- `0008_year_reset_acl_v1.sql`: ACL mínima #688 que concede `DELETE` à role backend nas dez relações posteriores mantidas como append-only até aqui. Não contém DML, `TRUNCATE`, DDL estrutural, reset de sequência ou acesso público/cliente; a exclusão anual continua pertencendo exclusivamente ao serviço autenticado/transacional.
- `0009_granular_observations_names_v1.sql`: separa observação vazia de ausência técnica e materializa nomes de avaliações usados pela experiência atual.
- `0010_qualitative_corrections_2026_v1.sql`: correção pontual #855 dos máximos qualitativos consolidados de 2026; permanece como registro da migration já aplicada, mas sua exceção de importação foi substituída pela fotografia autoritativa #862.
- `0011_gradebook_rls_v1.sql`: defesa em profundidade #856; ativa RLS nas 30 tabelas privadas preservando a ACL da role backend.
- `0012_current_state_cleanup_v1.sql`: limpeza #863 após a BN-DEC-038; apaga histórico granular de nota/instrumento, resíduos qualitativos sem definição/observação, tratamentos órfãos e importações sem referência retida; revoga INSERT/UPDATE de `gradebook_app` nos dois históricos legados.
- `0013_default_privileges_hardening_v1.sql`: hardening BN-12/#1036; remove grants automáticos de `gradebook_app` para tabelas/sequências/funções futuras. Como o `EXECUTE` padrão de `PUBLIC` para funções é global ao owner (não subtraível por schema), a migration também revoga esse default global para funções futuras criadas pelo mesmo migration owner; cada função futura deve conceder `EXECUTE` explicitamente. Não altera ACL dos objetos existentes nem dados.
- `0014_function_execute_hardening_v1.sql`: **APLICADA E POSTFLIGHT VERIFICADO (05/10/2026)** #1128/#1249; revoga `EXECUTE` de `PUBLIC` e, se existentes, `anon`/`authenticated` somente nas quatro funções originais. Preserva grants explícitos de `gradebook_app`, owner e demais consumidores; preflight completo e postflight efetivo (incluindo membership/`SET ROLE`) abortam a transação em caso de drift. Não muda funções, dados, RLS, schema ACL, memberships ou defaults. [Inventário, pre/postflight e recuperação sem reabrir PUBLIC](../../docs/gradebook/FUNCTION_EXECUTE_1128.md). Presença no Git não autoriza nem prova aplicação produtiva.
- `inspect_current_schema.sql`: consulta read-only e fingerprints estruturais por categoria. O JSON de referência é `catalog_20260910.json`, coletado do catálogo, não de notas ou arquivos. MD5 é checksum de drift, não garantia criptográfica. O comparador cobre tabelas/RLS, colunas/tipos/defaults/identidade, constraints, índices, funções e triggers. Não cobre dados, sequence counters, grants, proprietários, extensions ou infraestrutura.
- `application_role_grants.sql`: concessões para a role backend já provisionada, sem criar senha/login/superuser. Aplicar separadamente somente no ambiente autorizado e pelo proprietário de objetos previsto; default privileges valem para esse proprietário. Revisar grants/defaults herdados ao reconstruir em Supabase, em vez de presumir que a role anon/authenticated está bloqueada.

## Reproduzir e validar

Os testes `tests/gradebook/relational-schema/current-schema-v1.test.ts` criam banco PGlite descartável, executam a baseline completa e comparam os seis fingerprints do catálogo observado. Exercitam constraints, triggers, FK diferida e grants. Executar `npm run verify` antes de aceitar a entrega. Nenhum teste usa conexão de produção.

Para um ambiente PostgreSQL 17 **vazio e autorizado**, executar a baseline transacional por uma conexão privada. `CREATE SCHEMA gradebook` falha se o schema já existir: não há DROP/TRUNCATE/recriação silenciosa. Depois inspecionar com o SQL read-only, comparar o JSON e validar ACL efetiva. Usar o search_path padrão sem gradebook ao comparar as representações canônicas do catálogo. Manter timezone de operação America/Sao_Paulo por configuração autorizada; este arquivo não altera globalmente o banco.

A baseline não cria extensões, contas Supabase, bindings Hyperdrive, secrets, políticas de backup nem snapshots institucionais ainda não contratados. As migrations antigas de streams/versions são memória e **não** devem ser reaplicadas sobre o modelo simplificado.

As extensões correntes `0003` a `0014` são aplicadas em ordem, somente sobre
um schema já conferido contra a baseline. A aplicação autorizada de `0014` está
registrada no [postflight](../../docs/gradebook/POSTFLIGHT_0014.md). `0002` não integra essa sequência porque sua
relação já existe em `0001`. Para `0003`, o preflight deve confirmar
as oito tabelas-alvo ausentes e preservar uma cópia lógica recuperável das 20
tabelas e sequências anteriores. O arquivo usa uma única transação e falha
visivelmente diante de drift ou reexecução; não acrescentar `IF NOT EXISTS` para
contornar o gate. `0004` pode ser reaplicada com segurança para corrigir ACL, mas
não substitui o gate de `0003`. O postflight confere 28 tabelas, as quatro novas
sequências, ACL mínima exata de `gradebook_app`, ausência de privilégios `PUBLIC`, contagens centrais
inalteradas e somente o ano 2026. Ver
[`RELATIONAL_COUNCIL_V3.md`](../../docs/gradebook/RELATIONAL_COUNCIL_V3.md).

Para `0005`, o preflight confirmou as 28 tabelas pós-Conselho, ausência de `boletim_snapshot`, ano exclusivo 2026 e contagens acadêmicas; uma cópia lógica das 28 tabelas/12 sequências foi validada antes do DDL. O postflight produtivo de 11/09/2026 confirmou 29 tabelas no total e a relação nova vazia, com 13 colunas, 15 constraints, 4 índices totais, 3 FKs e ACL exata `SELECT, INSERT`, sem `UPDATE/DELETE` ou acesso público/cliente. Não emitir boletim real no smoke automatizado. Ver [`RELATIONAL_BULLETINS_V2.md`](../../docs/gradebook/RELATIONAL_BULLETINS_V2.md).

Para `0006`, a autorização explícita foi registrada depois do head verde da PR #675. Um dump privado novo das 29 tabelas foi validado e restaurado localmente antes do DDL. Preflight e postflight produtivos confirmaram a 30ª relação vazia, catálogo `30/246/218/66/52`, 13 sequências, ACL mínima e contagens acadêmicas inalteradas. O plano de recovery integrado deve passar a incluir essa relação depois da integração da #674, sem publicar o backup. Ver [`RELATIONAL_AUDIT_TREATMENT_V1.md`](../../docs/gradebook/RELATIONAL_AUDIT_TREATMENT_V1.md).

Para `0007`, o replay descartável deve partir da baseline `0001`, ignorar `0002` já refletida nela e aplicar `0003`–`0007` em ordem. O postflight deve comprovar a coluna `rec_rr_mask`, as máscaras disjuntas, os estados históricos `0..3`, a ausência dos dois checks de ano removidos e nenhuma alteração nas contagens acadêmicas. A Relação materializa o ano; planilhas de notas não o criam. Ver [`MULTIYEAR_RR_676.md`](../../docs/gradebook/MULTIYEAR_RR_676.md).

Para `0008`, o preflight confirmou o catálogo pós-`0007` e a existência exata das dez relações alvo. Aplicada em produção como `year_reset_acl_v1` (`20260912004843`), a migration ampliou somente a ACL de `gradebook_app` com `DELETE`; `PUBLIC`, `anon` e `authenticated` continuaram sem acesso. O postflight comprovou zero DML, contagens anuais idênticas e Advisor de segurança limpo. O smoke do deploy pode gerar prévia, mas não deve executar reset produtivo. Ver [`YEAR_RESET_SETTINGS.md`](../../docs/gradebook/YEAR_RESET_SETTINGS.md).

## Recuperação comprovada e limites institucionais

A #662 restaurou o artefato lógico V2 em PostgreSQL local descartável: 28 relações/120.879 linhas, IDs, 12 sequences, catálogo pós-`0005`, FKs, ACL local e jornadas selecionadas foram conferidos. RPO/RTO institucionais, restore gerenciado da produção, credenciais/configurações externas, failover e piloto integral permanecem gates #406/#596. Igualdade e restore locais não equivalem a backup/restore operacional da produção. A cópia D1 histórica não contém as novas escritas relacionais. Ver [`RELATIONAL_RECOVERY_REHEARSAL_662.md`](../../docs/gradebook/RELATIONAL_RECOVERY_REHEARSAL_662.md).

## 0017 — histórico das regras do ano (08/11/2026)

`0017_drop_ano_letivo_historico_v1.sql` remove `gradebook.ano_letivo_historico`. Aplicada em produção como `gradebook_0017_drop_ano_letivo_historico_v1` (`20261108091103`), depois do deploy do código que deixou de usar a tabela; postflight: tabela ausente, 39 tabelas com RLS, Advisor de segurança limpo. Nenhuma tela ou função muda a nota mínima ou o limite do Conselho depois da importação da Relação, então a tabela nunca teve linha. Aborta se tiver qualquer linha. O artefato lógico V2 da #662 continua restaurável: ele recria a estrutura antiga pelas migrações da época.

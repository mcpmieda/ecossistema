# Base estrutural atual: escopo comprovável e limites

Esta base registra metadados de leitura de `knzzyqgafdkwzjmdrfea` após PR #1273, em main `9477e41042fa5f9bd9d3978732e3fa391f4f5236`. É uma fotografia atual e um subconjunto reconstruível em PostgreSQL 17.6 descartável. Não reconcilia autoria histórica nem autoriza execução sobre banco existente. Issue #1274.

## O que entra

Quatro schemas de aplicação: gradebook, student_portal, student_photos e system_health. Metadados de 68 tabelas, 9 views, 16 sequências, 454 constraints (incluindo duas constraints de trigger), 145 índices, 17 triggers, 69 políticas, ACL de schema/relação/sequência/função/coluna e default privileges. A configuração das sequências é registrada, mas seu estado ou último valor não é extraído.

Das 38 funções, 33 corpos têm SHA-256 bruto igual a uma fonte pública fixada no Git. O manifesto registra identidade atual, hash e origem; o cabeçalho da reconstrução usa assinatura completa, linguagem, retorno, strictness, volatilidade, parallel, SECURITY INVOKER/DEFINER e search_path atuais do catálogo. Essa combinação comprova o corpo público e os metadados observados; não implica equivalência com uma migration histórica inteira.

## Cinco funções opacas: sem stubs

- student_portal.assert_year_reset_locks_v1
- student_portal.ensure_year_coordination_v1
- student_portal.inspect_year_reset_guard_v1
- student_portal.publication_source_rows_v3
- student_portal.synchronize_profiles_v1

Essas cinco têm somente metadados/hashes no manifesto e não são criadas. Funções comprovadas que as chamam também não são funcionalmente homologadas, incluindo capture_publication_source_v2, complete/consume/prepare_year_reset_v1 e synchronize_gradebook_profiles_v1; pode haver referências transitivas por SQL dinâmico. `check_function_bodies=false` permite registrar corpos conhecidos sem mascarar as dependências ausentes; nenhuma chamada desses caminhos constitui caso aprovado.

A revisão automática bloqueou uma consulta de inventário por risco de definições privadas. Não houve exportação de corpos privados nem contorno. As consultas seguintes usaram metadados e hashes de servidor. Completar esses corpos exige fonte pública exata ou aprovação específica de uma exportação restrita e revisada, sem segredos. Uma aprovação de código não autoriza publicação automática de definições privadas.

## Dependências e segurança

Auth, storage, realtime, vault, graphql, graphql_public, extensions e supabase_migrations são geridos/externos e ficam fora da reconstrução. O inventário registra pg_stat_statements, pgcrypto, plpgsql, supabase_vault e uuid-ossp; a instância comum do ensaio não reproduz os serviços Supabase, grants internos, configuração de extensão, rede, scheduler, Storage ou autenticação. Nenhum objeto vault nem credencial foi lido.

Os roles gradebook_app e student_portal_app são substitutos locais NOLOGIN/NOSUPERUSER/NOBYPASSRLS, sem senha e sem memberships adicionais. Os atributos produtivos registrados são somente metadados; não são reconfigurados. O postgres do container é superuser, diferentemente do role gerido da produção; não se atesta equivalência completa de autorização efetiva. As views preservam security_barrier observado, sem mudar silenciosamente para security_invoker. Funções SECURITY DEFINER e ACL atuais são preservadas somente na instância descartável.

A comparação usa identidades estáveis, sem OIDs. ACL é comparada por aclexplode, incluindo grantor/grantee/privilégio/grant option, e privilégios de coluna. Colunas são comparadas na ordem lógica observada: lacunas físicas de attnum deixadas por DROP COLUMN não são reproduzidas. Collation padrão e locale da instância são dependências ambientais; collation explícita é registrada. Grafo de catálogo não cobre referências em strings PL/pgSQL/SQL dinâmico. Estatísticas, comentários, dados, sequence values, ownership externo, tablespaces e serviços geridos não são homologados.

## Ensaio e incremental futuro

Workflow dedicado usa postgres:17.6, sem secrets ou environment produtivo. Nenhum SQL deste diretório está em migrations/ ou supabase/migrations/. O runner só permite execução nativa no GitHub com alvo fixo 127.0.0.1:55474/current_baseline_synthetic, rejeita conexão PG ambiental e usa /usr/bin/psql.

Reconstrói banco vazio e compara sets de catálogo, funções comprovadas, hashes, índices, constraints, sequências, views, triggers, RLS/policies e ACL. Ledger do teste contém 54 pares inventados e não é o ledger Supabase. Uma coluna sintética é candidata incremental com hash fixo. O ensaio verifica preflight dentro da transação, lock cooperativo + lock do ledger, rejeição de hash/drift/repetição, erro real depois de DDL/INSERT com rollback e duas sessões concorrentes: uma aplicação e uma recusa. Postflight exige o delta único e preserva as propriedades restantes. Todos os objetos e roles locais são removidos.

Isso valida o mecanismo transacional proposto no ambiente declarado, não um executor de produção. Locks cooperativos não impedem DDL de um ator que ignore o protocolo; não se testa rede interrompida após commit, mecanismo externo de ledger Supabase, integração GitHub Supabase ou comportamento funcional completo da aplicação.

Para uma mudança real futura: delimitar candidato específico com commit/hash e dependências; obter catálogo/ledger de leitura atuais; comparar drift com escopo declarado; revisar segurança, lock/tempo e rollback; testar em instância descartável; obter aprovação própria para o SQL e mecanismo no alvo; aplicar uma única mudança, registrar a versão efetivamente alocada e postflight. Não copiar esta base ao ledger, replay histórico, renomear versões, executar repair ou reativar integração por consequência.

As 54 versões reais e as 11 lacunas históricas de [PR #1273](https://github.com/mcpmieda/ecossistema-escola/pull/1273) permanecem intactas. A integração deve permanecer desligada; o navegador expirado e erro PC 10013 não foram contornados. Validação funcional e integração externa continuam pendentes. Resultados nativos serão registrados na PR e no artefato de CI, sem inferir equivalência a partir da simples geração.


# Ensaio sintético de reconciliação

O teste em `scripts/ci/supabase-reconciliation-trial/run.mjs` usa somente um PostgreSQL 17.6 descartável do GitHub Actions. Não usa segredos, SQL histórico, dados reais ou integração externa Supabase. Não é um executor autorizado para produção.

O candidato tem SHA-256 fixo `dd8cc13846b3b29a6380d8c5f640ed5f010ac155e7b3eb4dfa97bbea4d58bff2`. Os 54 pares iniciais são fictícios. Verifica aplicação única com commit, repetição bloqueada, hash alterado, divergência real do ledger e de RLS, erro SQL real após DDL/INSERT com rollback, catálogo/proprietário/RLS/ACL, preservação de 54 pares e delta único. Testa acesso efetivo negado e RLS default-deny mesmo com SELECT temporário. Remove schema e role sintéticos ao terminar.

O guard de catálogo roda antes da transação; o ledger é novamente verificado sob lock dentro dela. Este ensaio não comprova proteção contra toda concorrência de DDL, falha de rede após commit, integração Supabase, alocação real de versões, histórico produtivo, segurança das memberships reais ou funcionamento do deploy. Não fecha as 11 lacunas de proveniência.

Workflow separado: `.github/workflows/supabase-reconciliation-trial.yml`. Permissão apenas contents:read, sem environment de produção, sem secrets, sem deploy, sem dispatch operacional. Evidência JSON registra o head, versão, hash e casos aprovados. A execução local sem `--native` verifica apenas contratos; execução nativa exige GitHub Actions e conexão fixa ao banco sintético em 127.0.0.1:55473.

A publicação destes testes na PR #1273 foi autorizada especificamente. Merge, produção, ledger real, integração Supabase e Hyperdrive permanecem fora do escopo. O bloqueio local 10013 não foi contornado.

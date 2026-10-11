# Migrations: revisão e aplicação explícitas

Os arquivos SQL em `migrations/` são as fontes canônicas por módulo. A presença
de um arquivo no Git não autoriza sua execução nem comprova aplicação remota.
Consulte o README do módulo, a issue responsável e os respectivos preflights e
postflights antes de planejar qualquer alteração no banco.

## Caminho automático e espelho retirado

O commit `a946b7e4165c9f0f58a0e510fc0871b012ca2758` (PR #1222) introduziu
`supabase/migrations/20261001224416_student_portal_seal_cache_v1.sql` como cópia
isolada de `student-portal/0024_seal_count_cache_v1.sql`. Esse timestamp era de
geração local; a versão já aplicada é `20261001201546`, conforme o
[postflight 0024](../docs/student-portal/POSTFLIGHT_0024.md).

A integração GitHub do Supabase consome automaticamente o subdiretório
`supabase/migrations` do diretório de trabalho configurado. O espelho de um único
arquivo não representava o histórico remoto. O check anterior
[110608964022](https://github.com/mcpmieda/ecossistema-escola/runs/110608964022)
passou sem esse diretório; após sua introdução, o check
[110635461505](https://github.com/mcpmieda/ecossistema-escola/runs/110635461505)
falhou com `Remote migration versions not found in local migrations directory`.

A correção retira somente essa cópia do caminho automático. O SQL canônico e os
postflights permanecem preservados. Nenhum workflow, check, proteção ou configuração
da integração é removido ou alterado. Não recriar um espelho parcial em `supabase/`
como parte de uma migration de módulo: isso exige primeiro um plano próprio de
reconciliação completa e revisão da política da integração.

Na inspeção somente leitura de 10/10/2026, havia 54 versões remotas. A branch
Supabase associada a `main` apontava ao projeto principal, com
`MIGRATIONS_FAILED`, enquanto o projeto estava `ACTIVE_HEALTHY`. Falha de
sincronização do histórico não comprova indisponibilidade do banco.

**Limite da inspeção:** o conector disponível expõe branches e migrations, mas
não a política completa da integração; o navegador também estava indisponível.
Não foram confirmados os valores de Working directory, Automatic branching,
Supabase changes only ou Deploy to production. A semântica geral é descrita na
[documentação oficial da integração](https://supabase.com/docs/guides/deployment/branching/github-integration),
não inferida como configuração deste projeto.

Os workflows locais de PR validam código e usam bancos PostgreSQL descartáveis
em loopback. O gate privado Hyperdrive requer `workflow_dispatch` e opção
explícita; o deploy Cloudflare de produção depende de push à `main` ou acionamento
manual. A inspeção não encontrou consumidor local de `supabase/migrations`.
Publicar uma branch de revisão não é autorização para merge, deploy, rerun de
publicação ou alteração do banco. Antes de integrar esta correção ou habilitar
um fluxo automático de migrations, confirmar a política efetiva no Dashboard.

## Processo para novas migrations

1. Delimitar o SQL candidato no módulo responsável e revisar dependências, versão
   remota efetiva, compatibilidade com o código, locks, ACL/RLS, preflight,
   postflight e recuperação. Manter propostas ainda não autorizadas fora dos
   diretórios de aplicação; não ativar trabalhos candidatos por efeito colateral.
2. Comparar catálogo e ledger do ambiente alvo em modo somente leitura. Revisar o
   diff e validar lint, tipos, build e testes existentes com fixtures sintéticas
   e bancos descartáveis, sem dados reais ou segredos.
3. Obter autorização explícita para a operação no ambiente alvo, separada da
   aprovação do código. Aplicar somente o SQL pendente revisado pelo mecanismo
   autorizado, na ordem de compatibilidade acordada. Este documento não autoriza
   nenhuma execução.
4. Registrar na issue e no postflight o commit, hash do SQL, versão efetivamente
   registrada no ledger, verificações e limitações. Separar aplicação do schema,
   publicação do código e validação funcional.

## Reconciliação do ledger: escopo separado

Retirar o espelho não reconcilia as 54 versões remotas, não altera o ledger e não
garante que o check do Supabase passe. Não usar `migration repair`, `db push`,
`db pull` com efeitos, renomeação de timestamps ou arquivos vazios para esconder
a divergência. Não reaplicar `0024` sob a versão local `20261001224416`.

Uma reconciliação futura exige inventário completo somente leitura, associação
de versões ao SQL e às evidências históricas, identificação das baselines e dos
passos já incorporados, plano revisado e autorização própria. Há passos
destrutivos, como Portal `0019`; no Banco simplificado, `0002` já está incorporada
na baseline `0001`. Não transformar esses diretórios em uma sequência de replay
sobre o banco existente. Consulte os READMEs de
[Student Portal](student-portal/README.md) e
[Gradebook simplificado](gradebook-simplified/README.md).

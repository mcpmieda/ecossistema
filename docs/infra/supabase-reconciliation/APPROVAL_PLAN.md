# Caminho seguro para próximas migrations

Proposta revisada em 11/10/2026. Sem lote de produção autorizado nesta PR. O conjunto de mudanças propostas ao ledger histórico é **vazio**.
Preservar os 54 registros, as fontes por módulo e Deploy to production OFF. Não fazer repair, placeholders, squash de história, renomeação de versões ou replay para forçar sincronização.

## Encerrar a etapa documental

Aceitar o inventário com 43 fontes candidatas e 11 lacunas de arquivo exato declaradas. A comparação atual distingue 19 identidades de conteúdo registrado, 10 coincidências após trim, 12 diferenças de representação/conteúdo e 2 registros sem statements. Isso encerra a investigação documental delimitada; não prova uma sequência universal de replay nem reconciliação automática.

Uma rotação antiga sem fonte pública é um evento administrativo, não uma migration a ser reconstruída. Guardar somente metadados sanitizados. Reset inicial e passos incorporados não são aplicados novamente. As evidências faltantes e alternativas de encerramento estão por versão no mapa.

## Uma mudança nova, selecionada explicitamente

O caminho proposto mantém o mecanismo de aplicação explícita já utilizado pelo projeto, sem varrer diretórios legados ou reativar integração. Não é um novo runner implementado nesta PR.

1. Delimitar uma única mudança nova no módulo canônico. Reutilizar o processo do README e o mecanismo autorizado já existente; manter candidatos não autorizados fora de diretórios de aplicação automática. Se houver geração por CLI, consultar primeiro a versão e --help, e manter o resultado na área candidata isolada até revisão — não repovoar supabase/migrations.
2. Fixar commit, caminho, SHA-256 bruto do SQL, nome da mudança, projeto alvo, dependências do catálogo, risco de locks, compatibilidade do código, ACL/RLS e estratégia de recuperação. Não usar trim para aprovar um candidato novo: conferir bytes exatos.
3. Fazer preflight somente leitura: conferir main, os pares version/name e os fingerprints disponíveis dos registros históricos; verificar que o nome/artefato selecionado é novo e que nenhuma versão antiga foi selecionada para replay. Conferir OFF por leitura no Dashboard autorizado. Se qualquer evidência/setting divergir ou estiver inacessível, parar no gate pertinente.
4. Verificar as precondições estruturais específicas no catálogo atual e ACL/RLS efetiva, sem linhas pessoais. Igualdade do ledger não equivale a igualdade do schema. Baselines são referências para ambiente vazio/reconstrução aprovada, nunca candidatos a replay em produção.
5. Validar o SQL novo na infraestrutura nativa isolada já existente, com dados sintéticos mínimos: estado anterior, aplicação uma vez, preflight de repetição bloqueado, erro no meio, rollback quando suportado, pós-catálogo e ACL/RLS. Confirmar compatibilidade PostgreSQL 17.6 e extensões necessárias. Exercitar o mecanismo real selecionado ou demonstrar seu contrato transacional separadamente; um mock não comprova atomicidade de apply_migration.
6. Apresentar para autorização específica o artefato exato, preflight observado, resultado do ensaio, janela/locks, recuperação e o mecanismo de aplicação. Esta PR e sua aprovação documental não autorizam esse passo.
7. Somente após autorização, aplicar exclusivamente o artefato novo selecionado pelo mecanismo aprovado. Não enviar DDL por execute_sql como atalho, não executar db push/reset/pull com efeitos, não fazer INSERT/UPDATE manual no ledger. Se o mecanismo aloca a versão, capturar a versão efetivamente retornada: não antecipá-la como timestamp comprovado.
8. Fazer postflight somente leitura: os 54 pares e fingerprints anteriores permanecem iguais; existe exatamente a nova entrada esperada; registrar digest do conteúdo armazenado e qualquer transformação pelo mecanismo; catálogo, ACL/RLS e invariantes coincidem com o delta aprovado. Registrar separadamente schema aplicado, código publicado e validação funcional.
9. Se resposta ou estado forem ambíguos, consultar o resultado antes de qualquer retry. Não repetir SQL cegamente; se já aplicado, confirmar pós-condições. Se o mecanismo não permitir demonstrar consistência do schema e ledger, parar e preparar recuperação aprovada.

Uma futura migration concreta ainda não existe nesta entrega. O plano é **verificado nos gates documentais e de seleção**, mas **não liberado para aplicação de DDL**: o ensaio nativo local foi bloqueado e o mecanismo real não foi testado. [Evidência](VALIDATION.md).

## Risco e recuperação proporcionais

Antes do commit transacional, um erro deve deixar o catálogo e o ledger anteriores intactos — isso precisa ser demonstrado com a ferramenta real. Depois de commit, rollback depende do SQL: pode ser uma mudança compensatória revisada ou manutenção de schema aditivo compatível. Não declarar reversível um DROP, TRUNCATE, backfill ou remoção de dados sem cópia recuperável autorizada e testada.
Para DDL não transacional, exigir plano separado com estados intermediários, locks, reconciliação e postflight; não misturar com a hipótese transacional acima.
Nenhum dump de dados reais é solicitado por este plano genérico. Backup/restore, se necessário para uma mudança concreta, deve ter escopo privado próprio; não transmitir dados pessoais/segredos ao ensaio ou à PR.

## Se algum dia for necessário mudar o ledger

Exigir autorização separada com tabela ANTES/DEPOIS exata de version/name, hashes e motivação por registro. A comparação atual não identifica uma correção histórica obrigatória.
Uma restauração exata exige snapshot privado autorizado dos campos necessários; repair aplicado/revertido sozinho não garante restaurar name/statements originais. Não coletar SQL de senhas para publicar nem remover eventos apenas porque falta arquivo Git.
Repair altera histórico, não executa a correção do schema: [referência CLI](https://supabase.com/docs/reference/cli/supabase-migration-repair).
A CLI de push pressupõe histórico consistente; não usá-la neste inventário incompleto nem ajustar registros só para satisfazer a ferramenta: [guia migrations](https://supabase.com/docs/guides/deployment/database-migrations).

## Integração automática

Reativar branching/deploy ou mudar working directory é uma decisão separada. Exige desenho e ensaio específicos para banco vazio versus produção existente, completo mapeamento ou política explícita de legado e aprovação de configurações. Esta PR não propõe reativação.
Merge da documentação, aplicação de uma migration nova e reativação da integração são três decisões distintas. Nenhuma delas deve ser inferida de comentários de bots ou de sucesso de CI.

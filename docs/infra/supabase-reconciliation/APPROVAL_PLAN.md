# Plano de reconciliação — somente proposta

## Decisão segura atual
Preservar os 54 pares do ledger e Deploy to production OFF. A evidência não identifica um par incorreto que justifique repair. Não existe lote mutante aprovado nem lista honesta de correções executáveis neste estágio.

## Preparação necessária antes de autorização
1. Conferir main e os 54 pares novamente; abortar se houver drift. Reconfirmar OFF por leitura no Dashboard autorizado, sem salvar settings.
2. Completar evidências dos 11 eventos: procurar apenas metadados sanitizados nas issues/postflights e Git histórico autorizado. Para rotações, versão/nome/data/hash autorizado bastam; não recuperar valores ou corpos sensíveis.
3. Comparar catálogo estrutural e ACL/RLS efetiva por metadados, sem linhas pessoais. Distinguir schema atual, passos absorvidos pela baseline e operações administrativas.
4. Definir política desejada: arquivo de proveniência separado pode documentar os 54 sem mudar banco. Um novo fluxo automático requer desenho próprio para banco vazio versus produção existente; não gerar placeholders nem espelhos de replay.
5. Para cada mutação realmente necessária, produzir tabela ANTES/DEPOIS exata de version/name, motivação e prova. Atualmente: conjunto candidato de mutações = vazio.

## Se a decisão exigir alteração no ledger
Solicitar aprovação específica contendo projeto, versões exatas, operação por linha e snapshot esperado. Capturar antes, em armazenamento privado autorizado, uma cópia integral recuperável dos registros afetados (incluindo campos necessários à restauração); não exportar statements sensíveis para este relatório.
Validar a semântica da CLI instalada com --help e documentação oficial antes de redigir o comando final. Repair modifica histórico e não corrige schema: https://supabase.com/docs/reference/cli/supabase-migration-repair .
Executar somente após autorização, sem apply_migration/db push/reset/deploy e com OFF preservado. Confirmar pares após operação e comparar catálogo/ACL/RLS anterior.
Reversibilidade: metadados removidos só são restauráveis exatamente com snapshot completo; uma inserção aplicada de novo pode não restaurar name/statements originais. Não declarar reversibilidade só porque existe --status applied/reverted. Se snapshot exato não estiver disponível, parar.

## Riscos e parada
Marcar versão aplicada indevidamente pode esconder DDL faltante; marcá-la reverted pode induzir replay destrutivo ou rotação. Baselines sobre schema existente falham ou colidem; renomear timestamps destrói proveniência. Parar com mudança em main/ledger/settings, evidência ambígua, ausência de recuperação exata ou ACL insuficiente.
A publicação desta documentação em PR em rascunho foi autorizada. Isso não autoriza merge nem alterações operacionais. As 11 lacunas não foram resolvidas. Qualquer mudança futura no banco ou ledger exige aprovação específica de um plano concreto; o conjunto candidato de mutações continua vazio.


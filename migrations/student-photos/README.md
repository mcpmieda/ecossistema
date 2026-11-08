# Fotos — migrações

`0001`–`0004` são a base privada da #1119 já registrada no projeto Supabase. Não reaplicar essas versões nem a identidade `student-portal/0018` em produção.

`0005_supabase_storage_v1.sql` substitui a entrega binária permanente por referência ao bucket privado `student-photos`. A migration aborta caso encontre entregas ou ativos antigos, revoga a cópia quando a principal muda e remove o espelhamento de novas fotos para colunas SharePoint. As funções novas não são expostas a `anon`, `authenticated`, `service_role` ou ao backend do aluno. `adopt_storage_photo_v1` é exclusiva da migração administrativa.

Depois de conferir os 361 objetos e as referências originais, os backends foram publicados com a credencial privada e o roteiro de adoção foi executado (25/09/2026; o roteiro ficou no histórico do Git até o commit `4d12db0f`). O roteiro exige a contagem, os hashes agregados dos inventários e a correspondência única UID/objeto/tamanho; uma divergência aborta a transação inteira. Nenhum arquivo de origem é excluído. Verificar as entregas, RLS/ACL, Portal e editor no ambiente real antes de declarar aceite.

`0006_drop_legacy_profile_photo_v1.sql` (08/11/2026) remove a tabela `student_portal.profile_photo`, vazia desde a adoção, a leitura `legacy_reference_v1` e a adoção única `adopt_storage_photo_v1`. `initialize_family_v1` é recriada igual, sem a consulta antiga. Aborta se a tabela tiver qualquer linha.

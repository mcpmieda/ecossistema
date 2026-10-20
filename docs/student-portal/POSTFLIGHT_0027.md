# Postflight 0027 — política Frequência

Em 20/10/2026, a migration `0027_frequency_policy_v1.sql` foi aplicada pelo conector
Supabase no projeto `ecossistema-escola` como `student_portal_frequency_policy_v1`,
versão produtiva `20261020115021`, antes do Worker que grava o campo `showFrequency`.

SHA256 do SQL canônico:
`4B25D860110D26F336E1E13F25DA368EA8011CAFB0EBCB118F3793259839AA24`.
O conector aplicou o mesmo corpo sem `BEGIN`/`COMMIT` (a ferramenta já executa em transação).

Verificação posterior somente leitura:

- `student_portal_setting_field_v1` aceita os 11 campos, incluindo `showFrequency`.
- Nenhuma linha `showFrequency` gravada: em todos os níveis a frequência lê como desativada.
- Nenhuma conta, nota, política ou dado de frequência alterado na migração.

Antes da aplicação, a restrição aceitava os 10 campos de `0021` e não havia linha do campo novo.
Rollback de schema, se necessário, é recriar a restrição com os 10 campos depois de remover as
linhas `showFrequency`; o código anterior nunca lê nem grava o campo.

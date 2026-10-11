# Postflight 0024 — contagens de selos

Em 01/10/2026, a migration `0024_seal_count_cache_v1.sql` foi aplicada pelo conector
Supabase no projeto `ecossistema-escola` como `student_portal_seal_count_cache_v1`,
versão produtiva `20261001201546`. Escopo e integração: [#1221](https://github.com/mcpmieda/ecossistema-escola/issues/1221),
PR [#1222](https://github.com/mcpmieda/ecossistema-escola/pull/1222).

O SQL canônico e o espelho gerado pela CLI têm SHA256
`B1C21836A95F9C721E39C663FAE37D71AA6469FC4579D8BEB05DFD1B237561A9`.
O nome temporal do arquivo da CLI é o momento de geração; a versão acima é o
registro efetivo retornado pelo catálogo de migrações do ambiente produtivo.

Verificação posterior somente leitura:

- `student_portal` tem 28 tabelas; a tabela nova estava vazia.
- RLS habilitado; `student_portal_app` não é proprietário.
- Aplicação com SELECT, INSERT e UPDATE; sem DELETE.
- `anon`, `authenticated` e `gradebook_app` sem SELECT na tabela.
- Chave estrangeira por conta com remoção em cascata; nenhum nome, nota ou boletim
  armazenado no cache. Nenhuma conta, nota ou política alterada na migração.

O código de runtime foi validado no PostgreSQL nativo no head
`1d5a9243c4d724be5321f84eb738937d67ba9410`, execução
[36939466839](https://github.com/mcpmieda/ecossistema-escola/actions/runs/36939466839).
O teste de 105 contas comprovou totais equivalentes e zero consultas a payloads de
edições em leitura com cache válido. Também verificou invalidação, timestamp do
driver produtivo, escrita atrasada e permissões.

Este documento registra a aplicação do schema antes do Worker compatível. A
publicação e a verificação online subsequentes são registradas na #1221 com seus
SHAs e execuções; a presença da migração não comprova deploy ou homologação de uso.

## Retirada do espelho isolado

O espelho CLI `supabase/migrations/20261001224416_student_portal_seal_cache_v1.sql`
foi retirado do caminho automático da integração GitHub. O hash e a descrição
acima registram a cópia histórica; o SQL canônico permanece em
`migrations/student-portal/0024_seal_count_cache_v1.sql`, sem alteração.
A versão produtiva continua sendo `20261001201546`; o timestamp da cópia não é
uma migration pendente. A retirada não modifica o banco nem reconcilia o ledger
remoto. Processo e limites: [migrations revisadas](../../migrations/README.md).

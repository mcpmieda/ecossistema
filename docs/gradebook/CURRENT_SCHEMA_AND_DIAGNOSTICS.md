# FINAL-1 — baseline reproduzível e diagnósticos atômicos

Refs #633 / #636 e extensões #648/#654. A baseline e a Auditoria foram integradas anteriormente; em 11/09/2026 as migrations aditivas do Conselho V3 e de snapshots de boletim foram aplicadas após preflight e export lógico validado. Nenhuma linha acadêmica foi alterada por esses DDLs.

## Schema atual, não migração antiga

A pasta `migrations/gradebook-simplified/` contém a baseline reconstruída do catálogo e suas extensões ordenadas. `0001` continua a fotografia pré-Conselho: 20 tabelas, 127 colunas, 123 constraints (34 FKs), 38 índices, 4 funções e 3 triggers distintos; os seis eventos em `information_schema.triggers` não são seis triggers. O teste de baseline reexecuta essa fotografia em banco descartável e compara os fingerprints estruturais coletados, sem copiar dados acadêmicos. `0003`/`0004` levam o estado corrente a 28 tabelas, 214 colunas, 188 constraints, 58 índices, 48 FKs e 12 sequências, mantendo 4 funções e 3 triggers. O catálogo JSON de 10/09 permanece evidência histórica da baseline de 20 tabelas, não fingerprint pós-extensão.

`0005` acrescentou somente `boletim_snapshot`, sem backfill: a fotografia produtiva passou a 29 tabelas, 227 colunas, 203 constraints, 62 índices, 51 FKs e 12 sequências, preservando 4 funções e 3 triggers. O postflight confirmou a relação vazia, 13 colunas, 15 constraints, 4 índices totais (PK/unique + 2 explícitos), 3 FKs e somente `SELECT, INSERT` para `gradebook_app`; `PUBLIC`, `anon` e `authenticated` têm zero privilégios nessa tabela. A `0022` removeu `boletim_snapshot` em 20/11/2026, com a aba Boletins do Banco de Notas.

Após autorização explícita da BN-DEC-027, `0006` acrescentou somente `importacao_diagnostico_tratamento`, sem backfill: a fotografia produtiva passou a 30 tabelas, 246 colunas, 218 constraints, 66 índices, 52 FKs e 13 sequências, preservando 4 funções e 3 triggers. A relação nasceu vazia, com 19 colunas, 15 constraints, 4 índices, 1 FK e somente `SELECT, INSERT` para `gradebook_app`; `PUBLIC`, `anon` e `authenticated` têm zero privilégios. Todas as contagens acadêmicas permaneceram idênticas.

Após autorização da #676/BN-DEC-029, `0007` acrescentou somente `fechamento.rec_rr_mask`, ampliou para `3` os estados históricos dos campos REC e retirou as duas constraints físicas de ano fixo. O catálogo produtivo passou a 30 tabelas, 247 colunas, 221 constraints, 66 índices, 52 FKs e 13 sequências, preservando 4 funções e 3 triggers. Todas as contagens acadêmicas permaneceram idênticas; os 4.463 fechamentos anteriores ficaram com máscara zero e nenhum fato R/R foi inferido retroativamente.

As permissões backend da baseline estão em script separado. A consulta efetiva na produção confirmou anon/authenticated sem USAGE e sem leitura/escrita de tabelas; não habilitamos RLS por causa de alertas genéricos e revogamos acesso público/cliente explicitamente. `0004` neutraliza grants padrão do proprietário nas relações do Conselho; `0005` faz a própria revogação na relação de boletins. O export pré-`0005` preservou 28 tabelas, 12 sequências e 120.879 linhas lógicas fora do Git; formato, catálogo, conjuntos, contagens, JSON e SHA-256 `562E9AC562294DB560C0BFACE1E2EF1B392C7DE7D6336BB351D2018CAFCDEB4C` foram validados. A #662 restaurou esse artefato em PostgreSQL local descartável e conferiu linhas, IDs, sequences, FKs, catálogo/ACL local e jornadas selecionadas. Restore gerenciado, configurações externas, RPO/RTO e operação institucional continuam pendentes; ver [ensaio e limites](RELATIONAL_RECOVERY_REHEARSAL_662.md).

## Uma única operação dona do conjunto de diagnósticos

`POST /api/gradebook/import-diagnostics` delega a `replaceGradebookImportDiagnosticsSnapshotV1`. Locks transacionais por fonte (ano/arquivo) e conteúdo (hash) precedem DELETE + INSERT na mesma conexão/transação. Se inserir falhar ou a contagem escrita for incompleta, a transação reverte e mantém as evidências anteriores. Não existe conjunto parcialmente substituído.

A observação vazia é enviada pelo navegador: [] significa que uma leitura completa não encontrou problemas e limpa os anteriores. Falha da leitura/coleta não envia uma observação vazia por suposição. A UI informa quando a Auditoria não confirmou a atualização, mesmo quando não existem avisos novos. Repetir uma observação mantém somente os problemas atuais; não cria histórico de resolvidos. Conteúdo idêntico renomeado tem uma única evidência, atualizada para o nome corrente.

A rota acadêmica não apaga mais diagnósticos por hash separadamente. Isso elimina a corrida em que um import posterior removia evidências registradas por outra aba, além da limpeza antes de uma persistência malsucedida. A gravação de notas/fechamentos e a observação de diagnósticos continuam operações separadas; sucesso de uma não é confirmação da outra.

O contrato V1 não contém uma sequência de observação compartilhada entre abas. Portanto a regra é **última observação confirmada pelo servidor**, não promessa de identificar a versão cronologicamente mais nova de arquivos enviados fora de ordem. Atomicidade não altera essa limitação nem inventa versão/relógio do cliente. Locks protegem integridade, não decidem qual arquivo o operador deveria ter escolhido.

## Evidências e próximos gates

Testes cobrem schema completo, rollback após DELETE, confirmação incompleta, vazio, repetição, rename, isolamento de ano/arquivo, limite de 5.000 itens com número constante de instruções, input duplicado, HTTP/auth/capability/origin/no-store e ausência de escrita acadêmica. A #662 acrescentou contenção multi-sessão em PostgreSQL real: espera observável no advisory lock, conjunto final completo sem mistura e rollback após `DELETE`. A homologação visual após publicação autorizada continua gate separado.

Clientes já abertos em versão antiga devem recarregar após o deploy, porque antes deixavam de enviar o conjunto vazio. Não assumir resolução de diagnósticos por uma chamada isolada ao endpoint de notas. Leituras/catálogos/centrais e os contratos de adaptação dos demais consumidores continuam pendentes na #633; não foram concluídos por esta baseline.

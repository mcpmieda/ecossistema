# Frequência V2 — entrega candidata #1289

A frequência de 2026 atende todas as turmas regulares ligadas no núcleo de conciliação da #1269. O cadastro acadêmico, o `studentUid` e as decisões de identidade continuam sendo do núcleo central. Frequência não decide associações, não utiliza a posição da linha como identidade e não permite ao computador escolher um UID.

O código desta entrega é candidato; merge e publicação aguardam a validação do responsável. A preparação privada do Supabase foi concluída em 15/10/2026, conforme o pedido de deixar a base pronta para receber frequência. `schema-v1.sql` é somente memória da candidata #1268, não deve ser aplicado; o serviço e os testes V1 com conciliação independente foram retirados.

## Preparação do Supabase

As migrations abaixo foram aplicadas uma vez, após ensaio PostgreSQL 17.6 com executor sem superuser. MD5 e SHA256 dos bytes dos arquivos foram comparados ao SQL registrado no ledger; todos coincidiram.

| Arquivo | Versão no ledger | MD5 do SQL |
| --- | --- | --- |
| collector/0004_frequency_bridge_v2.sql | 20261015121114 | 64c3765925310357f75f5cf683d79c7c |
| attendance/0001_frequency_v2.sql | 20261015121124 | bab3f48241d12bbff59d06c5fe3a5512 |
| attendance/0002_runtime_bridges_v2.sql | 20261015121131 | 3b87390f4fa6babda25df09eb829d376 |
| attendance/0003_portal_frequency_read_v2.sql | 20261015121140 | 3baf0806793e56aaba2106abb988fd7d |
| attendance/0004_foreign_key_indexes_v2.sql | 20261015121602 | ebc36dfe66ae1834480f17dd60559b01 |

As 61 entradas anteriores do ledger permaneceram idênticas: fingerprint `cc76d2577bd5ccbeae648aca38f24bb6`, pela fórmula de `COLLECTOR_AUTH_PREPARATION.md`, excluindo somente as novas entradas. O postflight confirmou 13 tabelas com RLS forçada, constraints validadas, nenhuma leitura direta do Portal sobre ocorrências, nenhuma leitura do refresh cifrado por `gradebook_app`, nenhuma função pública de frequência e nenhuma membership SET/INHERIT nas bridges. As bridges não têm LOGIN, SUPERUSER, BYPASSRLS, INHERIT nem CREATE no schema.

A auditoria de segurança retornou zero avisos. O índice da FK de pareamentos e o search_path do trigger de autenticação foram corrigidos pela migration aditiva, preservando as três migrations antigas. Os quatro índices de apoio às novas FKs foram criados e conferidos como válidos/prontos. A contagem agregada de alunos permaneceu 384; todas as 15 turmas de 2026 já estavam mapeadas no núcleo. Lotes e ocorrências de frequência continuam vazios: nenhum dado real foi coletado ou transmitido para esta preparação. Essas verificações não equivalem a ensaio de carga ou ativação real do computador.

## Arquivos e integração

- `shared/attendance-contracts/frequency-v2.ts`: payloads estritos, limites e DTOs V2.
- `server/attendance/service-v2.ts`: serviço transacional PostgreSQL no adaptador oficial do Banco.
- `server/student-identity/reconciliation/resolve-source-batch-v2.ts`: resolução central em lote; o ponto de entrada V1 delega ao mesmo núcleo e conserva a rejeição de entrada inválida.
- `migrations/attendance/0001_frequency_v2.sql`: persistência privada, RLS, ACL, FKs sem cascade e índices.
- `migrations/collector/0004_frequency_bridge_v2.sql`: view pública somente para o backend e funções mínimas de lock/revogação do dispositivo.
- `migrations/attendance/0002_runtime_bridges_v2.sql`: revalidação central da evidência histórica e invalidação do preview do reset anual.
- `migrations/attendance/0003_portal_frequency_read_v2.sql`: leitura privada vinculada ao aluno, à conta e à sessão do Portal.
- `migrations/attendance/0004_foreign_key_indexes_v2.sql`: índices de apoio às FKs, às verificações de pai e à limpeza anual.
- `server/student-portal/integration/year-reset/frequency-writer-v2.ts`: registra uma alteração de frequência no protocolo de reset existente, sem alterar a revisão acadêmica.
- A composição HTTP administrativa e do dispositivo fica em `server/collector/frequency-http-v2.ts`, com `/api/gradebook/frequency/v2` para o Banco e `/api/frequency-collector/frequency` para o PC; a nova aba **Frequência** pertence à guia **Importação** do Banco. O Portal usa a composição autorizada existente.

O PC recebe as operações V2 por backend HTTP. Nunca recebe conexão PostgreSQL, senha de banco, refresh token Graph nem privilégio direto sobre tabelas. O transporte exige prova do dispositivo vinculada ao hash canônico de todo o pedido e nonce de uso único. O backend fornece o ator confiável somente após validar essa prova.

## Operações

`createFrequencyServiceV2(database).execute(payload, actor)` admite `status`, `receipt`, `save-settings`, `set-paused`, `rename-device`, `revoke-device`, `lease`, `heartbeat`, `release`, `collect`, `resolve-conflict` e `monthly-summary`.

Operações administrativas exigem o ator administrativo autorizado pela composição. Coleta, liderança, heartbeat e release exigem dispositivo. O tenant provém da identidade validada pelo servidor; não existe tenant, UID de destino nem configuração de calendário no payload da coleta.

Todas as mutations retornam `{contractVersion:2,state:'committed',operation,requestId,...}`. Recibo consulta o resultado original, nunca executa novamente uma mutation. O mesmo ID com outro payload/ator/dispositivo é recusado; repetição válida não regrava. Recibos de mutations não carregam nomes ou dados acadêmicos. Após reset, uma guarda opaca dos IDs antigos impede replay.

A agenda é compartilhada pela escola/ano, com timezone e as 14 regras semanais de turno. `save-settings` e `set-paused` usam CAS da revisão escolar. A agenda define quando coletar; não prova dias letivos, quantidade de aulas ou elegibilidade acadêmica.

## Identidade, histórico e conflitos

A captura resolve nome e turma de origem pelo núcleo central, em lote. Registros ambíguos ou não encontrados são persistidos sem atribuição. Várias origens podem identificar o mesmo UID. Ocorrências são únicas por ano/UID/data/turno/slot 1–6; turma, nomes originais, fontes e observações de conciliação ficam nas evidências privadas de origem.

A revalidação histórica usa uma única função central, `gradebook.reconciliation_evidence_valid_v2`: todas as origens guardadas precisam continuar ligadas ao mesmo UID, sem revisão pendente, com as observações e ligações de turma válidas. Nova matrícula do mesmo UID não invalida a matrícula antiga; correção para outra pessoa ou ligação de turma em revisão não reinterpreta a frequência anterior. O histórico acompanha o UID em turmas anteriores.

X e J equivalentes não duplicam a ocorrência. X/J divergentes e desaparecimento comprovado de marca abrem conflito. Snapshot parcial, ausência de aluno ou falha de coleta não apagam lançamentos anteriores. Apenas cobertura explicitamente completa daquele slot pode propor uma remoção, que continua exigindo escolha administrativa auditada. Correção guarda ator, motivo, valor anterior e posterior; CAS protege decisões concorrentes. Uma escolha não transforma registros vazios em presença.

Datas de matrícula e transferência são usadas apenas quando existem nas observações centrais. Datas futuras, de outro ano, slots fora do contrato ou marcas fora de vigência comprovada são rejeitados. Nunca é inventado calendário ou início de matrícula.

**Não há calendário de frequência produtivo nem quantidade de aulas aprovada nesta entrega.** Portanto, resumo mensal mantém `absences`, `justified`, `denominator` e `percentage` nulos; `coverage` é `incomplete` quando há evidência parcial e `unavailable` quando não há. Marcas X/J conhecidas aparecem como evidência parcial. Zero não significa ausência de evidência e não é retornado como total consolidado. Uma futura fonte acadêmica aprovada exige contrato e validação próprios antes de habilitar totais/percentual.

## Coordenação, armazenamento e reset

Existe uma lease por escola/ano, prazo de 15–300 segundos pelo relógio do banco, vinculada ao ator/dispositivo e com fencing monotônico. Nova concessão/renovação incrementa o fencing token. Heartbeat atualiza estado e última comunicação, mas não prolonga a lease. Outro computador assume somente depois da expiração ou release. Pausa bloqueia nova liderança e coleta.

Cada transação de dispositivo valida e bloqueia o grant/dispositivo com `collector_auth.lock_active_device_v2`, antes das gravações e antes do commit. Expiração é revalidada depois de qualquer espera; a coleta revalida também o prazo de liderança antes do commit. Revogação administrativa passa pela função privada do broker na mesma transação. Lote, marcas, origem, correções, CAS e recibo são atômicos; falha posterior desfaz as gravações fisicamente.

Captura idêntica ao último conteúdo e mapeamento atualiza somente frescor, metadados operacionais e recibo. Não copia novamente nomes, diário e marcas anuais. Em captura alterada, evidências de fonte, cobertura, marcas e proveniência são gravadas como diferenças; ocorrências equivalentes permanecem únicas. SQL de resolução, elegibilidade, fontes, marcação e conflitos trabalha em lote, sem uma consulta por aluno ou por marca.

Frescor novo somente alcança as evidências do batch correspondente; aluno omitido de um snapshot parcial mantém o horário da evidência anterior. A retenção mantém a proveniência mínima e a auditoria das alterações; não guarda PDF/arquivo bruto.

`frequencyYearCountsV2(tx,year)` retorna contagens das 11 tabelas anuais dependentes. `resetFrequencyYearV2(tx,year)` exclui dependentes explicitamente, conserva UIDs globais, muda geração, incrementa fencing, libera a liderança e mantém a escola pausada. O chamador usa o lock anual exclusivo do reset canônico. Alterações de coleta, configuração, nome/revogação e correção invalidam o preview existente sem fingir alteração de notas. FKs não usam cascade para contornar o reset. Contagens operacionais de recibos e comunicação podem variar depois da prévia; a execução recompõe as contagens reais sob o lock e exige que todas as exclusões correspondam a elas.

## Verificação

- `npx vitest run tests/attendance/postgres-v2.test.ts`: regressões sintéticas com PGlite e, com as variáveis do runner, PostgreSQL nativo. Cobrem operações, N→1, homônimos, transferência, matrícula adicional, conflitos/removação, idempotência, CAS, equivalência/diferenças, frescor parcial, autorização, rollback, expiração após trabalho no banco, ACL e reset.
- `tests/attendance/native-stack-v2.integration.test.ts`: aplica os bytes exatos da linhagem acadêmica/Portal, conciliação, Coletor e frequência, incluindo as três bridges; confere grants, isolamento do Portal, grant expirado/revogação e reset canônico com frequência.
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/attendance/run-local-postgres-v2.ps1 -PostgresBin <bin> -TestFile <suite>`: cluster exclusivo em diretório temporário marcado, loopback, sem serviço Windows, com prova do destino antes de SQL e remoção somente após encerramento confirmado.
- `.github/workflows/frequency-postgres-v2.yml`: dois jobs independentes com PostgreSQL **17.6**, fixtures sintéticas, migrations exatas e resultado JSON. Nenhum job usa Supabase produtivo.

Verificação local em 14/10/2026: PostgreSQL 17.6 confirmou a suíte de serviço e a aplicação dos bytes reais de todas as migrations, incluindo Portal 0026, com papel de migration sem superusuário e sem BYPASSRLS. As bridges conservaram somente a associação administrativa do criador sem SET/INHERIT; nenhum runtime recebeu associação, CREATE ou acesso às tabelas de autorização. O cluster descartável foi encerrado e removido ao final. As provas técnicas do head final ficam na PR. CI, migrations sintéticas e catálogo não comprovam login Microsoft/TPM/Smecel real, capacidade de carga produtiva ou homologação funcional. A validação real posterior pertence ao responsável; não substitui lint, tipos, build, gates e revisão do head final.

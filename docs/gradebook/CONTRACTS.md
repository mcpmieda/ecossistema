# Contratos — vigência, compatibilidade e lacunas

## Conciliação anual candidata — #1269 / #1276

[Conciliação V1](../student-identity/RECONCILIATION_V1.md) especifica o DTO discriminado, validação integral C3, continuidade de origem distinta de identidade, decisões duráveis, CAS/idempotência, ativação do lote e PIN numa transação, transição de nascimento/QR, retenção e reset. Contrato compartilhado registrado na #1276; implementação candidata sem merge, produção ou frequência desta fase. UIDs, notas, contas, fotos e autorização conservam seus contratos.

Retirada solicitada em 10/10/2026, registrada na #1271 e BN-DEC-043: remove a aba Relatórios e seu módulo institucional V1/V2, substituindo somente sua preservação/compatibilidade na BN-DEC-041. O endpoint antigo responde 410 autenticado com `{ state: 'retired' }`; Desempenho/PDF docente, Conselho, Auditoria e Boletins permanecem. [Escopo e consumidores](REPORTS_RETIREMENT_20261010.md). Estado de integração/publicação e SHA efetivo são registrados na #1271/PR #1270; não inferir homologação real.

A classificação canônica de versões `CURRENT / COMPATIBILITY / HISTORICAL` está em [CONTRACT_VERSION_MAP.md](CONTRACT_VERSION_MAP.md). **Não inferir vigência pelo maior sufixo `vN`.**

## Desempenho analítico #815

Transporte V6 aditivo, cinco perspectivas descritivas sobre a mesma projeção relacional e PDF docente disponível em Desempenho. V1–V5, autoridade, núcleo acadêmico e schema preservados. Contrato, sincronização, semântica, escopo por turma e limitações de validação em [PERFORMANCE_ANALYTICS_V6.md](PERFORMANCE_ANALYTICS_V6.md).

## Portal P2 — classificação de apresentação #745

`academic-presentation-v1.ts` contrata a entrada interna BN e reutiliza o valor
`meetsMinimum: boolean | null` do reader V1, sem campo/versão HTTP adicional.
Esta entrega define o contrato; o helper e a composição serão implementados na #747.

A autoridade proporcional já está em `application/results/relational-performance-facts-v2.ts`,
`performanceCellV2`. O mínimo vem de `gradebook.ano_letivo.minimo_aprovacao`, exposto
por `student_portal.academic_year_policy_v1.minimum_approval` no mesmo snapshot dos fatos
e da revisão. É um mínimo **anual em milésimos**, não percentual nem limiar absoluto
de cada instrumento. O denominador anual é a soma das constantes do núcleo
`SIMPLIFIED_TERM_MAXIMUM_MILLI_V1` (30.000 + 30.000 + 40.000 = 100.000).
Classificar exatamente `valor * máximoAnual >= máximoDaNota * mínimoAnual`, com
produtos inteiros sem perda de precisão; nunca arredondar o limiar, usar tolerância,
limitar a 100% ou fixar 60%. Esta classificação de apresentação não determina REC,
Conselho ou resultado anual, nem substitui AM/U oficiais pelos cálculos descritivos.

| Caso | Contrato |
| --- | --- |
| Valor abaixo / igual / acima do limiar | `false` / `true` / `true`; igualdade exata. |
| Zero normalizado pelo BN | Continua `score:0`; participa da comparação. |
| Ausente / N/C / R/R / REC pendente | Preservar `kind`; não acrescentar valor, máximo ou booleano. R/R continua terminal conforme núcleo, sem Conselho. |
| Máximo ausente, zero ou negativo | `null` na classificação; máximo inválido nunca vira denominador. Wire continua aceitando somente máximo positivo ou `null`. |
| Mínimo ausente | `null`; número inválido, fracionário ou não seguro é erro de contrato, sem coerção. |
| Acima do máximo | Preservar valor e classificar sem clamp; não corrigir fato oficial. |
| Parciais / T1…T3 / REC numérica aplicável | Mesmo helper; máximo do instrumento ou constante do trimestre, respectivamente. Aplicabilidade/ocultação continua antes da apresentação. |
| U interna | Preservar fato e máximo atualmente desconhecido (`null`), portanto classificação `null`; não criar célula anual no self V1. |

Exemplos exclusivamente sintéticos: com mínimo anual 60.000, máximo 30.000,
17.999 fica abaixo e 18.000 atinge; com mínimo anual 75.000, o mesmo máximo exige
22.500. Uma parcial de máximo 2.000 atinge o segundo perfil em 1.500, não em
75.000. Esses dois perfis verificam parametrização; não alegam dois mínimos
produtivos nem autorizam editar o mínimo atual.

Ownership: somente `src/gradebook-domain/calculations/simplified/resolve-student-mark-presentation-v1.ts`
implementará `ResolveStudentMarkPresentationV1` na #747; o adapter
`server/student-portal/academic/academic-reader-v1.ts` fornece os fatos e o mínimo.
Frontend #750 apenas mapeia `true`/`false`/`null` para apresentação azul/vermelha/neutra,
preservando texto e os marcadores; nenhum cálculo ou política acadêmica no browser.
Não mover nem modificar a classificação descritiva de Desempenho nesta entrega.

### Revisão de parâmetros e limite do produtor

O importador V11 finaliza mudanças efetivas do V9 após o flush físico; criação do
ano inclui os parâmetros iniciais e evento de Relação. Nome/turma/vínculo e
instrumentos/notas já participam do fluxo de revisão. Não confundir sincronização
de perfil cadastral Portal com edição da política acadêmica anual.
Na baseline auditada `910bb6f`, **não existe operação ativa para editar
`minimo_aprovacao`**. A função instalada `student_portal.record_gradebook_change_v1`
aceita `academic-policy`, mas não é trigger automático sobre a tabela.
O wrapper atual `server/student-portal/integration/year-reset/writer-v1.ts`
também não aceita essa causa; sua extensão tipada pertence ao futuro editor,
não a esta entrega de apresentação.
Qualquer produtor futuro de política exige escopo próprio: comparar mudança real,
adquirir a coordenação existente, atualizar parâmetros e registrar uma vez
`academic-policy`, `affects_academic=true`, lista anual vazia, na mesma transação.
No-op não chama o registrador; rollback desfaz tudo; replay conserva o evento.
Publicação/reader devem recusar a revisão antiga e exigir atualização explícita,
sem mudar por conta própria a publicação vigente ou o resultado acadêmico.

Provas em `tests/student-portal/bn-contract/presentation-*.ts`: compatibilidade e
entrada estrita, vetores de conformidade para #747, comparação com o classificador
BN existente para mínimos 60.000/75.000 e simulação PGlite de evento de política,
replay e rollback. A simulação prova capacidade do mecanismo, não um endpoint de
edição de perfil nem concorrência PostgreSQL nativa. Implementação/adapter e
aceite visual permanecem #747/#750/#757–#759.

Base: BN-DEC-022, #613 e programa #182. O [índice anterior completo](history/pre-final-1/CONTRACTS.md) é preservado; seus estados pertencem à época/modelo anteriores.

## Caminho relacional

| Fronteira                         | Referência                                                                                                                                                               | Situação                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Importação                        | `shared/gradebook-contracts/imports/import-persistence-transport-v9.ts`                                                                                                  | externo V9; homologado #613                                                                                             |
| Diagnósticos                      | `shared/gradebook-contracts/imports/import-diagnostics-v1.ts`                                                                                                            | evidência atual #629; atomicidade reforçada na #636 integrada/publicada                                                 |
| Serviço incremental               | `server/gradebook/application/import/import-relational-service-v11.ts`                                                                                                   | interno V10/V9, sem nova versão HTTP                                                                                    |
| Cálculo simplificado              | `src/gradebook-domain/calculations/simplified/`                                                                                                                          | núcleo em milésimos                                                                                                     |
| Projeção oferta/aluno             | `server/gradebook/application/results/relational-academic-projection-v1.ts`                                                                                              | aplicação interna; lote limitado na #636                                                                                |
| Projeção anual                    | `server/gradebook/application/results/relational-student-annual-projection-v1.ts`                                                                                        | turma atual, decisão humana separada; não transporte UI                                                                 |
| Contexto/pesquisa/Centrais V2     | `shared/gradebook-contracts/operational-workspace/operational-workspace-transport-v2.ts`                                                                                 | contrato #639; implementação integrada na PR #640                                                                       |
| Desempenho relacional V2/V3/V4/V5 | `shared/gradebook-contracts/performance/relational-performance-v2.ts`, `performance-analysis-v3.ts`, `performance-term-comparison-v4.ts` e `performance-dashboard-v5.ts` | matriz/lentes/detalhe integrados; comparação trimestral no mesmo ano; panorama e ranking descritivo no servidor na #672 |
| Conselho relacional V3            | `shared/gradebook-contracts/council/relational-council-v3.ts`                                                                                                            | contrato #648; sessão/CAS/idempotência/votos/histórico/fotografias, com decisão humana explícita                        |
| Boletins relacionais V2           | `shared/gradebook-contracts/bulletins/relational-bulletin-v2.ts`                                                                                                         | contrato #654/#676; ano explícito, AM/U oficiais, comparação descritiva, emissão/lote/histórico/reimpressão             |
| Auditoria atual V2                | `shared/gradebook-contracts/imports/import-diagnostics-v1.ts`                                                                                                            | #658/#676 reutiliza o contrato vigente para leitura corrente do ano global                                              |
| Tratamento humano da Auditoria V1 | `shared/gradebook-contracts/audit/import-diagnostic-treatment-v1.ts`                                                                                                     | contrato #674; migration aditiva autorizada/aplicada e código em integração pela PR #675                                |
| Reset anual V1                    | `shared/gradebook-contracts/settings/year-reset-contract-v1.ts`                                                                                                          | contrato #688; prévia versionada e execução transacional de um ano, sem reset global                                    |

Comparação relacional `match | mismatch | unavailable` e reconciliação histórica `match | expected-difference | mismatch | not-comparable` não são intercambiáveis. Nunca tratar indisponibilidade como correspondência.

Diagnósticos V1 admitem observação vazia. A #636 envia esse vazio e substitui o conjunto em transação, sem limpeza paralela pelas notas. Última observação confirmada pelo servidor; sem ordem cronológica entre abas nem histórico de resolvidos. Histórico acadêmico continua separado.

## Contexto e Centrais V2 — contratos #639/#676

O mesmo endpoint operacional distingue `contractVersion: 2`. São exclusivamente consultas: catálogo dos anos materializados, contexto/contagens, pesquisa e detalhe de aluno/turma/professor/componente no ano global. O bootstrap V2 retorna os anos que a Relação materializou, mais recente primeiro; o runtime antigo não governa a interface. Identidade inteira e ano explícito; nenhuma versão, lifecycle, data ou resultado acadêmico é fabricado. Vínculos atuais/históricos e ofertas vêm das tabelas atuais, sem carregar o runtime antigo.

Contrato inclui validação de entrada/saída, limites de página, busca literal e snapshot por requisição somente leitura/repeatable-read. O browser cancela/descarta respostas obsoletas, confere o contexto retornado e limpa informações quando perde autorização. Detalhes e limites em [RELATIONAL_CENTERS_V2.md](RELATIONAL_CENTERS_V2.md).

V1 não foi alterado para simular equivalência. A interface de Centrais passa a V2 na #640; a #660 define a Central de professor como configuração docente importada e recusa o transporte de escrita V1 incompatível antes de instanciar seu runtime. A #676 substitui o contexto fixo da #649 por seleção global em memória de anos materializados pela Relação. A antiga criação administrativa de anos continua removida; trocar contexto não cria ano e nenhum consumidor compara anos.

## Consumidores que exigem adaptação

Boletins montado no shell usa V2 relacional da #654; Conselho usa V3 relacional; Relatórios usa V2 relacional da #656; a #658 usa somente diagnósticos atuais; a #660 conclui a configuração docente como leitura das ofertas importadas. A #666 retira os frontends anteriores não montados, sem alterar seus contratos/endpoints de compatibilidade externa; o write docente V1 e a UI/rota dedicada do Audit Workspace V1 não são mais servidos. O ano global não converte consumidores restantes; apenas invalida e refaz suas leituras no mesmo contexto selecionado. Desempenho usa a projeção relacional V2/V3/V4. Ver [mapa](CONSUMER_MAP.md), [Configuração docente](RELATIONAL_TEACHER_CONFIGURATION_660.md), [Auditoria atual V2](RELATIONAL_CURRENT_AUDIT_V2.md), [retirada Audit V1](LEGACY_AUDIT_RETIREMENT_664.md), [retirada dos frontends antigos](LEGACY_FRONTEND_RETIREMENT_666.md), [Relatórios V2](RELATIONAL_REPORTS_V2.md), [Boletins V2](RELATIONAL_BULLETINS_V2.md), [Conselho V3](RELATIONAL_COUNCIL_V3.md), [contrato #646](FINAL2_SOURCE_DESKTOP_646.md), [comparação #649](TERM_COMPARISON_2026_V4.md) e [multi-ano #676](MULTIYEAR_RR_676.md).

## Auditoria atual V2 e tratamento humano V1 — #658/#674

A superfície ativa reutiliza `import-diagnostics-v1` somente para listar a fotografia corrente de `gradebook.importacao_diagnostico` no ano global. Ela detecta, explica e sugere; não resolve, descarta ou corrige registros. `AuditWorkspacePage` e o endpoint dedicado V1 foram retirados pela #664 após prova de ausência de consumidor. O contrato/núcleo V1 permanece porque Relatórios V1 ainda o usa internamente e não é fallback.

Achado corrente e trilha humana não são equivalentes. O snapshot corrente é substituído pelo fluxo de nova observação da fonte, inclusive vazio. O contrato #674 acrescenta somente `RECONHECIDO` e `ANOTAÇÃO` append-only; não existe resolução manual. A trilha não é apagada quando o achado desaparece e não muda fatos ou autoridade. A autorização explícita da BN-DEC-027 permitiu aplicar a migration aditiva; integração e publicação do código seguem a PR #675. Detalhes em [Auditoria atual V2](RELATIONAL_CURRENT_AUDIT_V2.md) e [trilha humana V1](RELATIONAL_AUDIT_TREATMENT_V1.md).

A política de retenção corrente é server-side: somente diagnósticos `blocking-error` e o warning `above-maximum` são materializados em `gradebook.importacao_diagnostico`. O contrato de transporte continua aceitando os demais códigos para compatibilidade e preflight; eles não ganham autoridade nem persistência apenas por serem enviados pelo cliente.

## Relatórios institucionais V2 — contrato #656

`contractVersion: 2` oferece catálogo, desempenho, Conselho, Auditoria atual e histórico/reimpressão de Boletins para o ano global explícito. É uma composição limitada de serviços relacionais vigentes: Resultado/Quantitativo/Qualitativo e comparação trimestral descritiva vêm de Desempenho; decisões e votos vêm do Conselho V3; achados atuais vêm de `importacao_diagnostico`; documentos históricos vêm exclusivamente de snapshots imutáveis V2.

O endpoint permanece `POST` por compatibilidade de transporte, mas as operações V2 não executam DML. Não há comparação entre anos, voto de diretor, correção automática, exclusão automática de vestígio humano nem relatório detalhado de avaliações sem oferta explícita. A investigação por avaliação continua na tela de Desempenho. Detalhes e limites em [RELATIONAL_REPORTS_V2.md](RELATIONAL_REPORTS_V2.md).

## Boletins V2 — contrato #654

`contractVersion: 2` opera no ano explícito selecionado e lê turma, aluno, oferta, instrumentos, notas, fechamento e decisão humana atuais numa transação read-only/repeatable-read. AM/U importadas têm autoridade oficial; valores nativos são comparação descritiva. `ASSISTIDO` mostra notas sem resultado geral; `N/C` é preservado em REC. Emissão incompleta falha fechada com motivos explícitos.

Snapshot é append-only, idempotente por conteúdo/série e versionado por CAS. Reimpressão não consulta fatos acadêmicos atuais. PDF recebe exclusivamente o snapshot persistido e é gerado localmente, sem segundo endpoint. Detalhes, limites e gates em [RELATIONAL_BULLETINS_V2.md](RELATIONAL_BULLETINS_V2.md).

Preservar interpretação histórica, ano explícito, identidade server-side, concorrência, idempotência, histórico, emissão/reimpressão e decisão humana. Não fabricar campos/IDs apenas para formatos obsoletos. Toda mudança em `shared/` exige issue `[BN][CONTRATO]`: a #639 autoriza V2; a PR #636 não modifica contratos compartilhados.

## Desempenho — fonte funcional

`PAINEL DESEMPENHO`, 29/08/2026: §§2–6 contexto/matriz/Recuperação/situação; §§7–14 lentes/investigação; §§15–19 leitura/segurança/frescor/HeroUI; §20 aceite. Execução #634.

Metas de §16.1: payload inicial até 500 KB compactados; backend inicial p95 até 600 ms aquecido; detalhe p95 até 400 ms; matriz utilizável até 2 s no cenário documentado. A #668 registrou medição autenticada verde dessas quatro metas em um recorte sanitizado publicado; o resultado não autoriza inventar regras/métricas nem se converte em SLA universal. Ver [cenário e números](PERFORMANCE_MEASUREMENTS_668.md).

O campo V2 legado permanece `comparability-not-contracted` para não reinterpretar clientes anteriores. A operação V4 da #649/#676 contrata separadamente apenas a comparação proporcional T2→T1 e T3→T1/T2 dentro do mesmo ano, nas lentes Resultado/Quantitativo/Qualitativo e no mesmo snapshot. Não compara anos, slots de avaliação nem herda configuração do runtime antigo.

## Conselho — única parte preservada do documento antigo

`APENAS CONSELHO`, 23/08/2026, sobretudo §12.9 pp.23–24: turma/aluno/discussão/decisão, evidências em camadas, não elegíveis, votação opcional, edição histórica e fechamento. Execução #635; a conciliação vigente é a decisão explícita #648.

Os códigos são exatamente 1 `APROVADO PELO CONSELHO`, 2 `REPROVADO PELO CONSELHO` e 3 `REPROVADO POR FALTA`. Votos registram somente favoráveis/contrários e presentes é derivado. Diretor, desempate e voto de minerva ficam fora do sistema; ADMINISTRADOR não implica diretor. A sessão fecha para escrita, cria fotografia imutável e só volta a aceitar comandos depois de reabertura justificada. Conselho anterior foi retirado do caminho ativo, sem apagar colunas históricas. O restante do documento antigo não governa importação, armazenamento, retenção ou Desempenho.

## Recuperação e schema

A baseline `migrations/gradebook-simplified/` foi reconstruída do catálogo e replay/drift tem teste próprio com tabelas completas, constraints, índices, funções e triggers. O teste sintético de projeção não é teste de reconstrução; são verificações separadas, integradas na #636 sem DDL produtivo. Restore dos dados/recursos externos continua pendente. Snapshots/votos/configurações ausentes só recebem extensão mínima após contrato/autorização.

## Anos materializados e R/R — contrato #676

`academic-year-v2` admite anos de 2000 a 9999, mas somente uma Relação importada pode materializar o contexto. Todos os transportes ativos carregam ano explícito e nunca comparam anos. `R/R` atravessa importação V9 como `['r']`, persistência como máscara própria, projeções como `RR`, componente como `failed-repeat` e resultado anual como `REPROVADO`; o Conselho deve recusá-lo como não elegível. Ver [MULTIYEAR_RR_676.md](MULTIYEAR_RR_676.md).

## Configurações e reset anual — contrato #688

`year-reset-contract-v1` expõe somente `preview` e `execute`. A prévia retorna contagens fechadas, revisão SHA-256 do ano/contagens e a frase exata de confirmação. A execução aceita somente a mesma revisão, `understandsIrreversible: true` e `RESETAR <ano>`; uma revisão divergente retorna `preview-changed`.

O serviço apaga os registros acadêmicos atribuíveis ao ano nas 30 relações do Gradebook e, ao concluir a mesma transação, elimina `revision_event`, provas de reset e `academic_revision` desse ano. Diagnósticos `ano IS NULL` não são inferidos. Diagnóstico com ano explícito só persiste quando `ano_letivo` está materializado; uma Relação recém-criada repete a Auditoria depois da persistência confirmada. O registro anual também sai; sequências/schema ficam. HTTP exige origem oficial, autenticação, `gradebook.persistence.admin`, provider PostgreSQL, gate produtivo e `no-store`. Ver [YEAR_RESET_SETTINGS.md](YEAR_RESET_SETTINGS.md).

## Portal do Aluno P1 — contrato BN #703

Baseline inspecionada: `9ac131b6be55f265b224c5096e45b63fbf37374a`, com #702 integrada. Esta seção congela contrato; não declara reader, revisionamento ou guard implantados. G-C exige #702 e #703 integradas e CI verde. DDL, implementação e concorrência real continuam nos owners D/G/S/H/I (#704/#706/#707/#714/#715).

| Contrato em `shared/gradebook-contracts/student-portal/` | Garantia e consumidor |
| --- | --- |
| `academic-revision-v1.ts` — AcademicRevisionV1 | Ano 2026, geração aleatória durável de 128 bits + contador decimal positivo (até 20 dígitos), serializados `generation:counter`; nunca `readAt`. D/S persistem; publicação compara por igualdade, sem ordenar strings. |
| `eligibility-v1.ts` — EligibilityV1 | Chave exclusivamente `(2026, aluno.id)`; vínculo corrente único, excluindo situação 6. S/Auth/Self usam a mesma versão e transação. |
| `academic-student-reader-v1.ts` — AcademicStudentReaderV1 | Leitura interna individual, estrita e mínima, na transação recebida. Não aceita escolha de aluno pelo navegador; S projeta, Self entrega somente publicação autorizada. |
| `year-reset-portal-guard-v1.ts` — YearResetPortalGuardV1 | Mesmo handle/conexão/transação do reset; resultado sem lista individual. G implementa ambas as operações; erro/ausência do adapter falha fechado. |

Os ports genéricos recebem o handle transacional real, não iniciam outra conexão. `null` no reader significa indisponível, versão divergente, vínculo ambíguo/inexistente ou saída; nunca libera projeção antiga como fallback. Ano ausente/fora de 2026 não produz identidade Portal. Os contratos BN não recebem conta, senha, QR, nascimento, token nem políticas Portal.

### Identidade e elegibilidade

Relação materializa `aluno.id`; nome não é chave de vínculo Portal. NOVATO é normalizado pelo importador atual para `NULL` (regular), e não se introduz situação 0 no DTO. Situações 1 ESPECIAL e 2 ASSISTIDO são elegíveis; 3 DESISTENTE, 4 TRANSFERIDO e 5 FALECIDO impedem autenticação/leitura imediatamente. Situação 6 FOI PARA é exclusivamente histórica; 7 ESTAVA NO é corrente regular. Zero ou múltiplos vínculos não-6 resultam `unresolved`, inclusive se houver históricos. Mudança de turma conserva conta/chave; retorno 3/4/5 → NULL/1/2/7 no mesmo ID pode restaurar elegibilidade, mas não desfaz bloqueio administrativo nem revive sessão, credencial ou vínculo explicitamente encerrado. Um ID novo exige vínculo explícito; nunca casamento por nome.

### Autoridade e minimização

| Campo/caso | Fonte e regra única |
| --- | --- |
| T1/T2/T3 finais | `fechamento.am` → `sourceAmMilli` da projeção relacional; nunca `calculatedAmMilli` como substituto. Ausente permanece `absent`. |
| Anual | `fechamento.u` → `sourceUMilli`, preservado internamente como `officialAnnual`; nenhuma soma Portal. O self PA V1 não tem célula anual: o adapter não inventa um novo período para U. |
| Resultado | Mesmo núcleo `resolveSimplifiedAnnualOutcomeV1` e precedência humana de `application/bulletins/relational-bulletin-v2.ts`: decisão formal somente regular/7, sem R/R; 1 aprovado, 2 sem resultado geral. Nunca exportar razões internas. |
| R/R e N/C | Máscaras de fechamento/projeção oficial: marcadores `rr`/`nc` em REC aplicável, distintos de zero. R/R resulta reprovado, sem Conselho; N/C segue núcleo como não comparecimento. `failed-attendance` é decisão humana 3 (falta), não tradução automática de N/C. |
| Zero/ausente | Usar milésimos já normalizados pelo importador. Zero acadêmico é `score:0`, ausente é `absent`; não reprocessar 0,1 ou texto bruto no Portal. |
| Máximo desconhecido | `maximumMilli:null`, nunca zero/fictício. `meetsMinimum:null` se a autoridade não permitir comparação; Portal não cria limiar acadêmico. |
| REC | Incluir apenas períodos cuja aplicabilidade oficial seja `true`; omitir os `false`/indeterminados, sem fabricar nota. Aplicável ainda pendente usa `recovery-pending`; não extrapolar regra do calendário. |
| Instrumentos/ordem | Instrumentos ativos segundo `active-instrument-predicate-v1.ts`, sem evidência bruta. `compareSourceSubjectPresentationV1` de `source/subject-abbreviations-v1.ts`, desempate por ID e `order` contíguo na saída. |

O adapter S converte milésimos para decimal apenas para apresentação e injeta `accountId` a partir da conta autenticada. Mapeia perfil/disciplinas para `shared/student-portal-contracts/ports-v1.ts` da #702; `classId` fica interno e `officialAnnual` não vaza por spread. Resultado anual EM CURSO/EM RECUPERAÇÃO/Conselho pendente → `in-progress`; aprovações → `approved`; reprovações, inclusive R/R e N/C → `failed`; decisão humana 3 → `failed-attendance`; ASSISTIDO → `not-applicable`. O schema não calcula a regra: testes com o núcleo oficial fixam a autoridade, e S deve provar a composição SQL completa.

São proibidos campos de professor, nome de arquivo, fórmula, comparação calculada, justificativa, voto, diagnóstico, fonte bruta e dados de terceiros. Schemas estritos rejeitam acréscimos em todas as camadas. O reader interno também contém PII e só pode circular no servidor autorizado, sem logs. Autorização e filtragem de publicação/calendário continuam responsabilidade PA; não são conferidas por `zod.parse`.

### Revisionamento e publicação

Toda transação com mudança efetiva no estado acadêmico relevante incrementa uma vez o contador anual e grava evento/outbox atomicamente. Sem mudança, rollback ou replay idempotente: nenhum incremento/evento. A geração persiste fora do conjunto apagado pelo reset; reset/restore muda a geração para impedir ABA. Não usar relógio, contagens ou hash do nome. Contador esgotado deve falhar fechado, nunca reciclar. Eventos anuais expandem os alunos via consulta paginada estável no consumidor S; o port PA com `studentIds` recebe lotes internos, não uma lista potencialmente truncada no evento BN.

Versão, elegibilidade e fatos vêm do mesmo snapshot; worker só troca publicação por CAS contra versões atuais acadêmica, política e segurança. Revisão mudou durante processamento: descarta resultado e reprograma, preservando falha fechada. A garantia inicia após bootstrap/versionamento de todos os produtores no [mapa](CONSUMER_MAP.md), não no merge deste schema. Hooks parciais não liberam S em produção.

### Matriz de aceite contratual

`tests/student-portal/bn-contract/contracts-v1.test.ts` verifica identidade/movimento/saída/retorno/ambiguidade, ano inválido, versões duráveis, invalidação sem mudança de contagem, geração nova, janela/ator/consumo, zero/ausente/máximo, marcadores REC, allowlist PA, ordem institucional, precedência do núcleo anual e compatibilidade real do cliente reset com HTTP 409. Teste de envelope sem filtro de status não prova consulta de contas bloqueadas/inativas: a fixture SQL dessas contas, preview/execute/encerramento atômicos, no-op/rollback de revisionamento e disputa entre conexões permanecem G/S/H. AM/U/decisão humana exigem ainda teste de adapter SQL contra o núcleo/boletim em S; o schema não pode provar procedência de um número. Limites de 100 disciplinas/6 períodos/12 parciais seguem #702; exceder é erro explícito, nunca truncamento silencioso. Falta de aplicabilidade oficial não autoriza inventar REC.

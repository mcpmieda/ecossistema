# Banco de Notas — ponto de entrada

## Retirada da aba Relatórios - candidata de 10/10/2026

Retirada solicitada em 10/10/2026: a candidata remove a aba Relatórios e seu módulo institucional V1/V2. O endpoint antigo responde 410 autenticado; Desempenho/PDF docente, Conselho, Auditoria e Boletins permanecem. [Escopo e consumidores](REPORTS_RETIREMENT_20261010.md). Entrega em branch/PR rascunho, sem integração ou publicação.

## Retirada da interface Centrais — 09/10/2026

A superfície Centrais, sua navegação e o atalho de cadastro em Desempenho são retirados por solicitação do responsável. O cadastro mestre anual e os serviços compartilhados permanecem: ano global e catálogo de turmas do Painel do Aluno continuam usando o transporte V2. URLs antigas voltam à Importação. [Impacto, consumidores preservados e validação](CENTERS_UI_RETIREMENT_20261009.md). A entrega fica em PR para revisão; integração e publicação exigem autorização do responsável.

## Importação — manutenção #1225 (02/10/2026)

A entrega F1–F6 preserva V9/V10/V11 e a autoridade acadêmica vigente; corrige rollback, mede chamadas físicas, agrupa catálogo/estado/instrumentos e limita buffer/fila. [Fluxo, evidências, limites e prestação de contas](IMPORT_PERFORMANCE_V11.md). Integração/publicação e uso real são registrados separadamente na #1225. F7 foi retirada deste release: escopo individual do Portal depende de contrato e aprovação próprios. Nenhuma migration ou reset de dados produtivos faz parte desta entrega.

## Continuidade atual — 20/09/2026

O programa funcional BN e a entrega institucional #596 continuam encerrados; a fila operacional atual é **#970**, criada para manutenção e reconciliação após os diagnósticos independentes. Não reabrir filas históricas por checkpoint antigo.

Baseline reconciliada nesta rodada: `main@cad68337b48c7d4a40477b088d36835c705246f2` (PR #963; deploy oficial `35487533274` SUCCESS). O schema `gradebook` permanece com 30 tabelas; a migration corrente no repositório e comprovadamente aplicada em produção é `0012_current_state_cleanup_v1.sql` (#863, versão Supabase `20260918163014`). O schema `student_portal` possui 27 tabelas privadas; `0015_student_portal_rls_v1.sql` foi aplicada e verificada em produção em #859/#963 (versão `20260920004859`).

A presença de um arquivo no Git não é, sozinha, prova de aplicação produtiva. `PROJECT_STATE.yaml` registra separadamente a árvore auditada e a evidência de produção. O bloco `historical_checkpoint_668` continua memória imutável, não fila nem autorização operacional.

A fila Portal Parte 2 #742 está concluída e não é mais a fila ativa do Banco. Manutenção nova parte de #970 e de suas issues filhas reproduzíveis. O redesign visual do Portal #964/#965 é trabalho separado e não altera a autoridade acadêmica do Banco.

## Fechamento factual em 11/09/2026

FINAL-1 #633, FINAL-2 #634, FINAL-3 #635, FINAL-4 #406 e aceite acadêmico #347 estão encerrados. A baseline consolidada é `main@80b2916185fc6a49df7c5ab0af71e2be4dcdeb66`, com CI `34667519751` e deploy `34667699446` verdes. O [piloto integral](FINAL4_PILOT_406.md) e a [operação institucional](FINAL_OPERATION_596.md) substituem os estados intermediários abaixo como ponto de execução.

O ano oficial é 2026; 2025 é massa descartável de teste materializada para o ciclo anual. `imported-source` permanece oficial, `native-engine` descritivo, comparação é apenas trimestral dentro do mesmo ano e R/R é reprovação automática fora do Conselho. Backup gerenciado/RPO/RTO foi explicitamente adiado e continua ausente. Desde 23/11/2026 (BN-DEC-049) o aluno com R/R aparece no Conselho só para conhecimento, sem deliberação.

## Estado integrado e entrega corrente

A #613 encerrou a reconstrução e homologou a persistência PostgreSQL/Supabase via Hyperdrive `PROD_DB`: 19 tabelas centrais + `importacao_diagnostico` = 20. Importador externo V9, serviço interno único de importação (`import-service.ts`, que uniu as antigas camadas V10/V11) e retenção de diagnósticos atuais estão homologados. Não reabrir streams/versions, backfill ou importadores arquivados.

A #636 integrou planejamento reconciliado, leituras em lote, baseline de schema reproduzível e Auditoria transacional (deploy 254). A #640 integrou contexto, pesquisa e quatro Centrais somente leitura V2 (deploy 255). A #641 corrigiu as dependências sinalizadas e registrou a autorização contínua (deploy 256). Deploy não equivale a aceite funcional integral.

**#642 / PR #643:** primeira matriz calculada de Desempenho sobre o schema atual, com T1/T2/T3/Visão geral, Recuperação, situação, detalhes e ano compartilhado com Centrais. Integrada em `8866b2c897bb62528970c64740cd2509c5d28602` e publicada pelo deploy 257 / `34511487276`, reconfirmado com sucesso. A consulta é identificada como **em validação**; não é emissão oficial nem aceite global da #347. [Contrato, evidências e limites](RELATIONAL_PERFORMANCE_V2.md).

**#644 / PR #645:** quatro lentes sobre o mesmo snapshot relacional, com gráfico que investiga a matriz e estatísticas descritivas. Qualitativo preserva a pontuação existente, sem inventar conceitos; Avaliações exige componente explícito. A comparabilidade ainda pendente naquele checkpoint foi resolvida depois pela #649. [Contrato e limites da entrega](PERFORMANCE_LENSES_V3.md). SHA integrado e deploy efetivos ficam no checkpoint #644/#645; não deduzi-los da presença deste documento.

**#646 / PR #647:** corrige placeholders qualitativos sem evidência, adota siglas observadas na fonte, conclui a composição desktop/detalhe e estende um único ano global a todas as áreas acadêmicas, com mapeamento estrito para contratos legados. Comparabilidade e configuração sem decisão permanecem fechadas; validação visual final foi adiada. [Contrato e limites da entrega](FINAL2_SOURCE_DESKTOP_646.md).

**#649 / PR #650:** naquele checkpoint, substituiu a escolha multi-ano por contexto fixo 2026 e contratou a comparação descritiva T2→T1 e T3→T1/T2. A #676/#678 posteriormente materializou anos por importação e restabeleceu o seletor global isolado. Continua proibida a comparação entre anos. [Contrato V4 histórico](TERM_COMPARISON_2026_V4.md) e [extensão atual](MULTIYEAR_RR_676.md).

**#648 / PR #653:** Conselho V3 relacional integrado, migrado e publicado no deploy 262, com decisão humana 1/2/3, votos numéricos, empate fora do sistema, histórico e fotografia de fechamento. Smoke autenticado somente leitura aprovado; validação visual conjunta permanece adiada. Desde 23/11/2026 (BN-DEC-049, #1558) o Conselho guarda só o estado atual, sem linha do tempo, histórico ou fotografia, e a reunião só abre, sem justificativa (não há mais fechar nem reabrir; a turma aparece concluída quando todos os alunos a deliberar têm decisão). No mesmo dia, o registro de decisão, a contagem de votos e a lista de não elegíveis saíram do código para serem refeitos; o aluno com recuperação ainda não lançada passou a ser deliberado e os reprovados por N/C ou R/R na planilha aparecem só para conhecimento. A migration `0023` aguarda aplicação em produção. [Contrato e evidências](RELATIONAL_COUNCIL_V3.md).

**#654 / PR #655:** a aba Boletins V2 foi removida em 20/11/2026 por pedido do responsável, com a tabela `boletim_snapshot` (migration `0022`), para ser refeita mais simples. O Boletim do Portal do Aluno não muda.

**#656 / PR #657:** Relatórios institucionais V2 integrado e publicado no deploy 264 (`34577894561`), sobre as projeções relacionais vigentes de Desempenho, Conselho, diagnósticos atuais e snapshots de Boletins. CI e smoke autenticado somente leitura estão verdes. [Contrato e limites](RELATIONAL_REPORTS_V2.md).

**#658 / PR #659:** Auditoria relacional atual V2 integrada e publicada no deploy 265 (`34580485339`). A superfície ativa exibe somente a fotografia corrente de diagnósticos de 2026, em linguagem escolar, sem montar o Audit Workspace V1 ou oferecer correção automática. A trilha humana durável continua explicitamente separada. [Escopo e limites](RELATIONAL_CURRENT_AUDIT_V2.md).

**#660 / PR #661:** configuração docente relacional integrada e publicada no deploy 266 (`34585674112`). Professor, componente e oferta permanecem derivados da importação; a Central apresenta o cadastro reconhecido com HeroUI e a ordem P, M, H, G, C e demais componentes configurados, enquanto o write V1 incompatível deixa de ser servido. Smoke autenticado somente leitura verde; sem schema/DML ou autoridade nova. [Decisão e limites](RELATIONAL_TEACHER_CONFIGURATION_660.md).

**#662 / PR #663:** recuperação lógica e contenção PostgreSQL integradas em `89cb382d588364560ac250a4a1f0e0d65a079573` e publicadas no deploy 267 (`34600229510`). O artefato privado foi restaurado em banco local descartável com 120.879 linhas/28 relações, 12 sequences, catálogo pós-`0005`, FKs e ACL local conferidos. Jornadas selecionadas, advisory lock/rollback de diagnósticos e CAS/idempotência do Conselho passaram em conexões reais. Restore gerenciado, RPO/RTO e configuração externa continuam próprios. [Evidência e limites](RELATIONAL_RECOVERY_REHEARSAL_662.md).

**#664 / PR #665:** retirada seletiva da superfície Audit Workspace V1 integrada em `dc8005e7911b1dbfda914345a8c194987b6ebc22` e publicada no deploy 268 (`34602595928`). Três módulos UI e o endpoint dedicado sem consumidores foram removidos; Auditoria Atual V2, diagnósticos relacionais e o núcleo V1 ainda usado por Relatórios V1 permanecem intactos. [Prova e limites](LEGACY_AUDIT_RETIREMENT_664.md).

**#666 / PR #667:** retirada dos clusters frontend antigos de Centrais, Desempenho, Conselho, Boletins e Relatórios integrada em `fc6547f1cf994a9f87fe5c01fd80c1b58c5de642` e publicada no deploy 269 (`34604746376`). Endpoints, handlers, contratos, serviços, adapters e o renderizador PDF V1 ainda reutilizado permanecem. [Prova e limites](LEGACY_FRONTEND_RETIREMENT_666.md).

**#668 / PR #669:** medição autenticada de Desempenho no site publicado. No cenário 2026/T1/Regular/Resultado, p95 de dashboard e detalhe, payload Brotli e tempo até a matriz utilizável passaram nas metas da #634. É evidência pontual, não SLA universal; a rodada manual posterior gerou #672/#673 e sua aceitação encerrou a FINAL-2. [Cenário e resultado](PERFORMANCE_MEASUREMENTS_668.md).

**#674 / PR #675:** trilha humana append-only da Auditoria integrada e publicada. Reconhecimento e anotação não resolvem nem ocultam achados e não alteram fatos acadêmicos. A migration `0006`, CI, deploy e smoke autenticado estão verdes. [Contrato e gate](RELATIONAL_AUDIT_TREATMENT_V1.md).

## Leitura e execução

1. [COMECE_AQUI.md](COMECE_AQUI.md): tarefa e dependências.
2. [PROJECT_STATE.yaml](PROJECT_STATE.yaml): baseline e entrega corrente.
3. [DECISIONS.md](DECISIONS.md): decisões anteriores e substituições expressas.
4. [ARCHITECTURE.md](ARCHITECTURE.md), [CONSUMER_MAP.md](CONSUMER_MAP.md), [RELATIONAL_CENTERS_V2.md](RELATIONAL_CENTERS_V2.md), [RELATIONAL_TEACHER_CONFIGURATION_660.md](RELATIONAL_TEACHER_CONFIGURATION_660.md), [RELATIONAL_PERFORMANCE_V2.md](RELATIONAL_PERFORMANCE_V2.md), [PERFORMANCE_LENSES_V3.md](PERFORMANCE_LENSES_V3.md), [FINAL2_SOURCE_DESKTOP_646.md](FINAL2_SOURCE_DESKTOP_646.md), [TERM_COMPARISON_2026_V4.md](TERM_COMPARISON_2026_V4.md), [PERFORMANCE_MEASUREMENTS_668.md](PERFORMANCE_MEASUREMENTS_668.md), [RELATIONAL_COUNCIL_V3.md](RELATIONAL_COUNCIL_V3.md), [RELATIONAL_REPORTS_V2.md](RELATIONAL_REPORTS_V2.md), [RELATIONAL_CURRENT_AUDIT_V2.md](RELATIONAL_CURRENT_AUDIT_V2.md), [RELATIONAL_RECOVERY_REHEARSAL_662.md](RELATIONAL_RECOVERY_REHEARSAL_662.md), [LEGACY_AUDIT_RETIREMENT_664.md](LEGACY_AUDIT_RETIREMENT_664.md) e [LEGACY_FRONTEND_RETIREMENT_666.md](LEGACY_FRONTEND_RETIREMENT_666.md): caminhos e limites.
5. [CONTRACTS.md](CONTRACTS.md), [ROADMAP.md](ROADMAP.md), [ISSUE_MAP.md](ISSUE_MAP.md) e [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).

## Programa final

| Fase    | Issue | Resultado                                                                                         |
| ------- | ----- | ------------------------------------------------------------------------------------------------- |
| FINAL-1 | #633  | Concluída: consumidores relacionais, Auditoria humana, restore/contenção local e aceite visual    |
| FINAL-2 | #634  | Concluída: Desempenho, comparação trimestral, refinamentos e aceite visual                        |
| FINAL-3 | #635  | Concluída: Conselho humano, votos, histórico, fechamento e aceite visual                          |
| FINAL-4 | #406  | Concluída: piloto integral, ciclo anual descartável, matriz sanitizada e limitações classificadas |

#347 encerrou o aceite acadêmico por consumidor/escopo. #596 consolida a operação institucional com o risco de backup aceito e adiado; #220 permanece expansão transversal não bloqueante. #637 foi a remediação de dependências, com [evidências próprias](SECURITY_REMEDIATION_637.md).

## Fontes funcionais e invariantes

`PAINEL DESEMPENHO` governa sua experiência. Do documento antigo `APENAS CONSELHO`, somente Conselho permanece funcionalmente vigente. F1 = **7/7** e outros fechamentos antigos valem no seu contexto, não como prova automática da compatibilidade atual. [Planejamento anterior preservado](history/pre-final-1/README.md).

Uma regra, um núcleo; fatos/referências separados dos derivados; nenhum resultado fictício; Conselho humano; históricos preservados; diagnósticos resolvidos removidos na leitura correspondente; auth/capabilities no backend; no-store; sem dados acadêmicos persistentes no browser ou dados privados em Git/CI. Nome `d1-*` não demonstra provider físico: conferir composição e SQL.

Fluxo: issue/contrato → commit na branch → revisão → `npm run verify`/CI do head final → integração/deploy oficial → evidência sanitizada. **BN-DEC-023 dispensa nova confirmação por PR concluída**, não os gates nem autorizações próprias para dados/schema, infraestrutura ou autoridade acadêmica.

Entrega atual de anos materializados e `R/R`: [MULTIYEAR_RR_676.md](MULTIYEAR_RR_676.md).

# Matriz de testes — Banco de Notas

## Conciliação candidata — #1269 / #1276

- Domínio/normalização: três regras, vetos, continuidade/hash alterado, N→1, perfis inteiros, homônimos, rejeição, normalização, datas civis/1900/1904/INEP; somente fixtures sintéticas.
- Serviço PostgreSQL: validação C3 antes de persistência, lote atômico e rollback, receipts, CAS obsoleto, pendências sem UID, pessoas sem conta, separação/liberação, histórico de origem, cursor, allowlist e revisão de turma (`reconciliation-core.postgres.ts`).
- Ponte PostgreSQL: KDF retomável de quatro, falha no último PIN sem publicação parcial, mesmo ano sem regeneração, CAS/expiração/ACL, transição e reversão do legado (`reconciliation-credentials.postgres.ts`).
- Reset: prévia/contagens, pendência antes da Relação, geração/replay, invalidação por escrita/limpeza, guarda de contas e limpeza de staging. Relação testa explicitamente outra pessoa na mesma posição, correção de grafia e proibição de mover notas entre UIDs.
- UI/parser: cabeçalhos e células sintéticos, modalidades, erros por linha, prepare→stage→apply, paginação, decisões, ficha somente leitura e emissão QR independente. APIs manuais permanecem rejeitadas.
- Lint/tipos/build, suítes existentes, PostgreSQL nativo e gates do head final continuam obrigatórios. [Limites e validação real posterior](../student-identity/RECONCILIATION_V1.md).

## Retirada de Relatórios - #1271 / BN-DEC-043

- Menu/busca/abas não anunciam Relatórios; URL antiga, hashchange, voltar/avançar e recarga normalizam para Importação, preservando lote em andamento.
- O tombstone exige origem, método, identidade e capacidade; autorizado recebe 410 `{ state: 'retired' }` no-store sem body, banco/bindings ou limiter externo. A regra versionada `unavailable` de BN-DEC-041 não se aplica mais a Reports; demais transportes permanecem.
- Desempenho/PDF docente, Boletins, Conselho e Importação/Auditoria continuam exercitados por seus consumidores/testes atuais.
- No ensaio de recuperação PostgreSQL descartável, o GET vigente de `import-diagnostics` deve responder 200/`ready` e corresponder aos IDs recuperados, aceitando um backup sem diagnósticos. A observação sintética do teste de contenção também deve ser legível pelo GET; o adapter exclusivo retirado não é restaurado.
- Mapeamento e paginação continuam cobertos em PGlite por `import-diagnostics-snapshot-v1.test.ts`. O gate PostgreSQL executa `relational-recovery-contention-v2.integration.test.ts` sem skip; CI completo e gates não são reduzidos.

## Retirada da interface Centrais — 09/10/2026

- Menu lateral, abas e índice de busca não anunciam a superfície removida; fontes exclusivas de UI não existem.
- `area=operational` na entrada, navegação repetida e `hashchange` simulado abre Importação e corrige o endereço sem adicionar entrada de histórico nem desmontar importação em andamento.
- Teclado percorre as áreas restantes; o detalhe de Desempenho fecha, reabre e mantém foco sem o antigo atalho cadastral.
- Ano global preserva bootstrap, isolamento por ano, recarga e falhas de autorização; catálogo de turmas do Painel do Aluno continua usando o mesmo cliente V2.
- Transporte HTTP, validação de contexto/resposta, paginação, no-store, origem, autenticação e read-only permanecem cobertos pelas suítes existentes.
- Os testes de montagem das ondas anteriores são atualizados; asserções de API/contratos e demais módulos são preservadas. Os registros históricos de jornadas de Centrais abaixo não exigem recriar a UI retirada.

## Retirada #1079 / BN-DEC-041

- Transportes legados: HTTP 410 depois de auth/capability/origem/validacao,
  sem tocar bindings, runtime ou banco; manter 401/403/400 e no-store.
- Versoes atuais e importacao V9/V10/V11: suites existentes preservadas.
- PostgreSQL nativo: SQL literal, JSON explicito, contagem/CAS, rollback,
  mesma transacao fisica, diagnostico e configuracao lazy sem fallback D1.
- Fronteira do arquivo historico: nenhum import ativo de D1/Aprendizados;
  fachadas sem prepare/exec/batch. Testes mistos leem memoria como texto.
- Testes exclusivamente D1 sao memoria em `Aprendizados/RUNTIME-D1-RETIRADO-1079`,
  nao prova de comportamento produtivo. CI/gates e publicacao registrados na #1079.

Todo teste versionado usa dados sintéticos ou anonimizados. Arquivos reais são usados somente em validação controlada fora do repositório e produzem relatórios agregados sem nomes/notas identificáveis.

## SRC — Contrato da fonte V1 histórico

- `SRC-001`: guia D1 reconhecida sem sufixo.
- `SRC-002`: guias D2 e D3 reconhecidas e vinculadas à disciplina correta.
- `SRC-003`: `J1`, `K2`, `K3` e `K4` lidos corretamente.
- `SRC-004`: sob V1 histórico, atividade com nome `*` ou máximo zero não é aplicável; artefatos V1 continuam interpretados por essa versão, sem transportar essa heurística para V2.
- `SRC-005`: guia protegida pode ser lida sem remover proteção.
- `SRC-006`: guia oculta/auxiliar é classificada sem virar guia de nota.
- `SRC-007`: nome inesperado gera diagnóstico, não descarte silencioso.
- `SRC-008`: arquivo original não é modificado.

## SRC2 — Definições trimestrais SourceContractV2

- `SRC2-001`: `R3`/`S3` são máximo/configuração das avaliações quantitativas 1/2 e `R/S` de estudante começam na linha 5.
- `SRC2-002`: `AA3:AJ3`, `AA4:AJ4` e `AA5:AJ...` permanecem naturezas distintas: máximo/configuração, nome livre e valor do estudante.
- `SRC2-003`: máximo/configuração preserva número, vazio e `*` sem coerção destrutiva.
- `SRC2-004`: vazio, `*` e máximo não positivo permanecem `insufficient-data`; nenhum produz `not-applicable` ou `maximum: 0` por heurística.
- `SRC2-005`: nome qualitativo preserva texto livre, Unicode, acentuação e nome longo.
- `SRC2-006`: `R/S` resolvem como `quantitative-assessment` com rótulos estruturais; `S` nunca vira `simulation` por posição.
- `SRC2-007`: `SourceContractV1` permanece interpretável e não é reescrito retroativamente por V2.
- `SRC2-008`: `T`, `Z`, `AK`, `AM` e `AN` permanecem agregados importados; a definição granular não os recalcula.

## SRC3 — Definições qualitativas SourceContractV3

- `SRC3-001`: máximo numérico positivo em `AA3:AJ3` resolve `configured/applicable`.
- `SRC3-002`: `*`, vazio, missing, unrecognized, booleano, zero, negativo ou não finito sem lançamento resolvem `maximum-not-defined`, nunca `not-applicable`.
- `SRC3-003`: os mesmos estados com qualquer lançamento permanecem `insufficient-data`/bloqueados.
- `SRC3-004`: máximo desconhecido ou não positivo nunca vira `maximum: 0` nem componente materializado.
- `SRC3-005`: `AA4:AJ4` é texto livre de exibição; nome ausente/inválido não muda aplicabilidade e usa fallback estrutural.
- `SRC3-006`: R/S preservam integralmente a resolução V2.
- `SRC3-007`: cada trimestre resolve seu próprio slot; configuração diferente entre T1/T2/T3 não é conflito por si só.
- `SRC3-008`: slot com `maximum-not-defined` não gera `AssessmentComponent` nem `GradeEntry`.
- `SRC3-009`: slot aplicável continua gerando componente e lançamento somente para seu próprio slot.
- `SRC3-010`: `T`, `Z`, `AK`, `AM` e `AN` permanecem observações autoritativas, sem recomposição granular.
- `SRC3-011`: V1/V2 continuam interpretáveis sob suas versões históricas.

### SourceContract V4 / ResultsContract V3

- `SRC4-001`: máximo qualitativo positivo materializa componente com máximo `defined`.
- `SRC4-002`: máximo qualitativo vazio, marcador, ausente ou não positivo materializa componente com máximo `not-defined` sem bloquear.
- `SRC4-003`: nota presente sem máximo produz `GradeEntry` autoritativo e mantém o valor bruto disponível.
- `SRC4-004`: reimportação com máximo definido conserva stable key, component ID e grade-entry IDs, acrescentando versão sem duplicação.
- `SRC4-005`: nenhum máximo fictício é usado; indicador dependente de denominador permanece indisponível.
- `RES3-001`: D1 persiste e versiona `AssessmentComponentV3` no payload JSON sem novo DDL.
- `RES3-002`: a lente de avaliações retorna nota bruta e máximo `not-defined` após reconstrução provider-independent.
- `RES3-003`: T/Z/AK/AM/AN não são recompostos a partir dos lançamentos qualitativos.
- `SRC3-012`: Transport V4 conserva o wire shape; V5 vigente delega a política qualitativa ao materializador V3 sem mascarar estrutura, limites, identidade ou trust boundary inválidos.

## RES2 — AssessmentComponent/Results V2

- `RES2-001`: V2 publica `quantitative-assessment | qualitative-activity | parallel-recovery`, sem `written/simulation` para R/S.
- `RES2-002`: tipos V1 históricos `written | simulation | qualitative-activity | parallel-recovery` continuam interpretáveis sob V1.
- `RES2-003`: componentes R/S resolvidos usam ID opaco, tipo quantitativo genérico e ordem estrutural 1/2.
- `RES2-004`: nome e máximo são versionáveis e não alteram a chave estável do mesmo slot/contexto.
- `RES2-005`: chave estável isola fonte lógica, ano, teaching assignment, trimestre e slot estrutural.
- `RES2-006`: autoridade e estados acadêmicos existentes permanecem herdados de V1; a evolução não cria regra de resultado.

## CELL — Semântica de célula

- `CELL-001`: vazio é ausência, não zero.
- `CELL-002`: `0,1` manual preserva origem e vale zero semanticamente.
- `CELL-003`: zero manual legado permanece zero real.
- `CELL-004`: número positivo manual é lançamento.
- `CELL-005`: número negativo é preservado e auditado.
- `CELL-006`: fórmula não zero conserva fórmula/cache e é válida.
- `CELL-007`: fórmula zero é ausência segundo o contrato vigente.
- `CELL-008`: fórmula sem cache/erro gera ocorrência.
- `CELL-009`: texto inválido não é convertido em nota.
- `CELL-010`: não aplicável, não lançada e campo inexistente são distintos.

## IMP — Importação

- `IMP-001`: 1, 20 e 50 arquivos processados sequencialmente.
- `IMP-002`: lote com mais de 50 é recusado antes da leitura.
- `IMP-003`: falha de um arquivo não cancela os demais.
- `IMP-004`: formatos XLSB, XLSX e XLS são aceitos.
- `IMP-005`: arquivo sem guia de nota gera falha individual explicável.
- `IMP-006`: manifesto registra nome, tamanho, modificação e SHA-256.
- `IMP-007`: reimportação do mesmo hash não duplica lançamentos.
- `IMP-008`: versão alterada substitui o estado atual do mesmo slot; nota/instrumento anterior não gera histórico granular.
- `IMP-009`: progresso e resultado por arquivo permanecem coerentes.
- `IMP-010`: nenhum arquivo é enviado/persistido sem ação prevista no fluxo aprovado.
- `IMP-011`: snapshot V1 omite instrumento qualitativo realmente apagado já no navegador e o PostgreSQL remove a definição atual e suas notas.
- `IMP-012`: definição indisponível preserva somente os campos não lidos e gera diagnóstico com guia/célula/causa; não é confundida com exclusão.
- `IMP-013`: vazio de aluno em instrumento ativo continua “Não fez”; vazio de coluna removida não produz `nota(NULL)`.
- `IMP-014`: importações novas não escrevem `nota_historico` nem `instrumento_historico`.
- `IMP-015`: o preflight visível mostra apenas `blocking-error` e `above-maximum`; warnings técnicos continuam disponíveis internamente para preservação fail-safe sem inflar contadores/avisos da UI.

## ID — Identidade, matrícula e transferências

- `ID-001`: posições históricas são preservadas mesmo fora de `J1`.
- `ID-002`: `FOI PARA 6B` + `ESTAVA NO 6A` cria trajetória e uma posição vigente.
- `ID-003`: notas replicadas no destino não duplicam resultado atual.
- `ID-004`: novato com notas anteriores válidas mantém as notas.
- `ID-005`: transferido/desistente/falecido mantém histórico preenchido.
- `ID-006`: ponto inicial e marcas significativas distinguem homônimos.
- `ID-007`: nomes semelhantes não são associados automaticamente entre anos.

## ENG — Motor nativo

- `ENG-001`: máximos trimestrais 30, 30 e 40.
- `ENG-002`: composição 45% quantitativo / 55% qualitativo conforme perfil vigente.
- `ENG-003`: arredondamento em 0,24; 0,25; 0,74; 0,75 e valores negativos.
- `ENG-004`: paralela em 59,9%, 60% e 60,1% do quantitativo.
- `ENG-005`: quantitativo considerado preserva original e aplica a maior paralela conforme regra.
- `ENG-006`: recuperação final substitui o trimestre aplicável mesmo quando menor.
- `ENG-007`: total anual antes e depois da recuperação.
- `ENG-008`: aprovação em 59,9; 60 e 60,1 pontos.
- `ENG-009`: 0, 1, 2 e 3+ componentes não aprovados para elegibilidade ao Conselho.
- `ENG-010`: situação especial/decisão formal respeita a precedência oficial.
- `ENG-011`: resultados parciais e cobertura insuficiente não viram resultado final inventado.
- `ENG-012`: mesma entrada + mesma versão de regra produz saída determinística.

## REC — Recuperação

- `REC-001`: originais `X`, `Y`, `AA` e total `AB` conferem com os trimestres.
- `REC-002`: aplicabilidade `AC`, `AD`, `AE` controla somente o trimestre correspondente.
- `REC-003`: notas `R`, `S`, `T` permanecem separadas dos originais.
- `REC-004`: total pós-REC `U` é conciliável com a regra nativa.
- `REC-005`: ausência de nota REC não é zero.
- `REC-006`: AC/AD/AE com fórmula preserva expressão/cache; somente o resultado numérico `1` é aplicável e qualquer outro número finito é `not-applicable`.
- `REC-007`: fórmula de aplicabilidade sem cache nem valor/erro visível resolve ausência não aplicável; valor/erro visível sem cache exige revisão.
- `REC-008`: célula esperada dentro do range da guia e omitida do XLSB é vazia; endereço fora da estrutura permanece `missing-field`.

## AUD — Reconciliação e Auditoria

- `AUD-001`: valor importado igual ao nativo gera `match`.
- `AUD-002`: divergência esperada é identificada e explicada.
- `AUD-003`: divergência real não substitui nenhum valor silenciosamente.
- `AUD-004`: erro crítico impede aparência de sucesso completo.
- `AUD-005`: ocorrência informa arquivo, guia, célula, entidade, regra e ação.
- `AUD-006`: resolução preserva usuário, data, justificativa e estado anterior.
- `AUD-007`: rejeitar um arquivo não perde os demais arquivos válidos do lote.

## UI — HeroUI e experiência funcional

- `UI-001`: Banco usa o mesmo shell/topbar/sidebar/pesquisa/perfil do Centro.
- `UI-002`: usuário leigo entende a tarefa principal sem configurar o sistema primeiro.
- `UI-003`: estados loading, erro, vazio, parcial e concluído são distintos.
- `UI-004`: teclado, foco visível e leitor de tela cobrem ações principais.
- `UI-005`: redução de movimento é respeitada.
- `UI-006`: celular não exige layout de desktop comprimido.
- `UI-007`: cor nunca é o único sinal de significado.
- `UI-008`: nenhuma tela calcula regra acadêmica no componente React.

## PERF — Desempenho

- `PERF-001`: read model inicial contém apenas ano/turma/período/lente.
- `PERF-002`: sem N+1 por aluno ou componente.
- `PERF-003`: matriz prioriza leitura sem overflow quando houver largura.
- `PERF-004`: detalhes são carregados sob demanda e respostas antigas são descartadas.
- `PERF-005`: comparação usa percentual quando máximos diferem.
- `PERF-006`: sinal analítico nunca altera estado acadêmico.
- `PERF-007`: payload e latência são medidos em cenário documentado; evidência autenticada da #668 passa as metas sem convertê-las em SLA universal.
- `PERF-008`: clicar fora fecha o Select aberto; trocar diretamente entre Selects fecha o anterior e abre o próximo em um único clique.
- `PERF-009`: Resultado classifica toda soma numérica pelo limite proporcional de 60%, preservando ausência como ausência; as lentes de composição continuam exigindo completude.
- `PERF-010`: clicar em qualquer barra azul/vermelha substitui o gráfico, no mesmo espaço, pela lista rolável dos alunos abaixo do mínimo daquele componente, sem filtrar a matriz; rótulos não são cortados na altura máxima.
- `PERF-011`: a classificação dos dez maiores somatórios inicia recolhida e só ocupa espaço quando o usuário a expande.
- `PERF-012`: a matriz mantém linhas compactas e reserva uma linha para a Situação; o status histórico usa exatamente `ESTAVA NO <turma>` recebido da Relação.

## SEC — Segurança e privacidade

- `SEC-001`: capabilities verificadas no servidor.
- `SEC-002`: busca não revela entidade sem permissão.
- `SEC-003`: respostas acadêmicas usam `Cache-Control: no-store`.
- `SEC-004`: localStorage/sessionStorage/IndexedDB/Cache API não armazenam notas sem decisão explícita vigente.
- `SEC-005`: logs e telemetria não contêm nomes, notas ou payload acadêmico.
- `SEC-006`: nenhuma fixture ou artefato público contém dado real.

## F3-648 — Conselho relacional V3

- `F3-648-001`: request/response aceitam somente 2026, limites explícitos e decisões 1/2/3 com os rótulos contratados.
- `F3-648-002`: abertura, decisão, voto, fechamento e reabertura exigem justificativa, idempotência e CAS da sessão.
- `F3-648-003`: sessão fechada bloqueia decisão/voto; reabertura justificada preserva fotografias anteriores e permite novo fechamento.
- `F3-648-004`: fechamento exige referência de revisão corrente e zero estudantes elegíveis pendentes.
- `F3-648-005`: cada fechamento preserva fotografia por aluno com elegibilidade/motivo/decisão/votos e não é alterado por comandos posteriores.
- `F3-648-006`: somente favoráveis/contrários são persistidos; presentes é derivado e diretor/desempate/voto de minerva não existem no transporte nem no schema.
- `F3-648-007`: elegibilidade vem do read model relacional central e não é convertida automaticamente em decisão humana.
- `F3-648-008`: estudante não elegível recebe motivo e não aceita decisão/voto; situação de matrícula e definições incompletas falham de forma explícita.
- `F3-648-009`: HTTP exige autenticação, `gradebook.persistence.admin`, origem oficial e `no-store`; provider/gate indisponível falha fechado.
- `F3-648-010`: migration é aditiva/transacional, não altera linhas/colunas legadas e restringe tabelas/sequências à role backend.
- `F3-648-011`: HeroUI cobre fila, detalhe T1/T2/T3/REC, KPIs, estados vazios/erro/loading, votação, decisão, sessão, timeline e histórico responsivo.
- `F3-648-012`: `npm run verify`, CI do head, revisão, postflight, deploy e smoke seguem BN-DEC-023; aceite visual conjunto continua explícito e separado.

## F1-654 — Boletins relacionais V2

- `F1-654-001`: request/response aceitam somente 2026, rejeitam campos extras, lotes duplicados e mais de 50 alunos.
- `F1-654-002`: catálogo usa nome completo da turma e materialização ordena disciplinas pela fonte canônica.
- `F1-654-003`: AM/U importadas permanecem oficiais e cálculo nativo aparece somente como comparação descritiva.
- `F1-654-004`: boletim anual mostra AM normal, REC e `N/C` juntos; `ASSISTIDO` mantém notas sem resultado geral.
- `F1-654-005`: ausência de fonte oficial necessária, cobertura incompleta, recuperação ou Conselho pendente bloqueiam emissão com motivos explícitos.
- `F1-654-006`: materialização de lote usa transação read-only/repeatable-read e contagem limitada de consultas, sem N+1 por aluno/componente.
- `F1-654-007`: repetição do mesmo conteúdo é idempotente; mudança real avança versão; CAS impede séries conflitantes.
- `F1-654-008`: reimpressão lê exclusivamente o snapshot histórico e não materializa fatos atuais nem grava nova versão.
- `F1-654-009`: migration adiciona uma relação/13 colunas/2 índices, FKs/checks de 2026 e ACL `SELECT, INSERT`, sem backfill/DML acadêmico.
- `F1-654-010`: HTTP exige autenticação, `gradebook.persistence.admin`, origem, provider/gate e `no-store`.
- `F1-654-011`: HeroUI cobre filtros estáveis, preview, emissão/lote, histórico, estados acessíveis, tabela anual e instrumentos sem drag/select nativo no código.
- `F1-654-012`: PDF aparece somente para snapshot emitido/reimpresso, é lazy/snapshot-only, limitado a um documento e falha sem apagar a leitura em tela.
- `F1-654-013`: `npm run verify`, CI do head, backup/preflight, migration/postflight, revisão, merge/deploy e smoke seguem BN-DEC-023; visual conjunto continua separado.

## F1-656 — Relatórios institucionais relacionais V2

- `F1-656-001`: request/response são estritos, aceitam somente 2026, IDs inteiros e operações catalog/performance/council/audit/bulletin-history/bulletin-reprint.
- `F1-656-002`: catálogo vem do Boletim V2 relacional e preserva nome completo e ordem canônica das disciplinas.
- `F1-656-003`: desempenho reutiliza V3/V4 e oferece Resultado/Quantitativo/Qualitativo, modos Regular/Recuperação e comparação somente T2→T1 ou T3→T1/T2.
- `F1-656-004`: não há comparação entre anos, tendência inventada, nova métrica acadêmica nem relatório de avaliações sem oferta explícita; a investigação detalhada permanece em Desempenho.
- `F1-656-005`: Conselho reutiliza V3, preserva os três rótulos oficiais, registra somente favoráveis/contrários e mantém diretor/desempate fora do sistema.
- `F1-656-006`: Auditoria lista somente achados atuais de `importacao_diagnostico`; correção remove o achado atual em seu fluxo de origem, mas não autoriza exclusão automática de vestígio humano nem correção automática.
- `F1-656-007`: histórico e reimpressão de Boletins consultam exclusivamente snapshots imutáveis V2 e não materializam fatos atuais.
- `F1-656-008`: todas as operações V2 são somente leitura, limitadas e sem N+1; teste PostgreSQL valida schemas, ordem, contagem e ausência de INSERT/UPDATE/DELETE/TRUNCATE.
- `F1-656-009`: HTTP exige autenticação, `gradebook.persistence.admin`, origem, provider/gate e `no-store`; falhas e respostas obsoletas fecham sem reusar dados anteriores.
- `F1-656-010`: HeroUI cobre filtros estáveis, estados vazios/erro/loading, KPIs, tabelas e timeline; não há card gigante de título, select HTML visível nem drag de coluna.
- `F1-656-011`: a interface ativa monta somente V2; V1 permanece compatibilidade isolada e não é fallback.
- `F1-656-012`: `npm run verify`, CI do head, revisão, merge/deploy e smoke seguem BN-DEC-023; validação visual conjunta continua separada.

## F1-658 — Auditoria relacional atual V2

- `F1-658-001`: a superfície ativa monta somente `RelationalCurrentAuditPageV2`; Audit Workspace e painel V1 não são montados nem usados como fallback.
- `F1-658-002`: a leitura usa apenas `GET /api/gradebook/import-diagnostics`, fixa 2026 e não consulta entidades/records do modelo anterior.
- `F1-658-003`: achados correntes vêm de `gradebook.importacao_diagnostico`; uma nova observação transacional da fonte substitui o snapshot anterior, inclusive por vazio, e remove tratamentos de chaves que deixaram de existir.
- `F1-658-004`: a interface explica que achado atual não é histórico de tratamento e não oferece reconhecer, resolver, descartar ou corrigir.
- `F1-658-005`: a trilha humana durável futura permanece pendente de contrato explícito; nenhum histórico, linha ou schema é fabricado nesta entrega.
- `F1-658-006`: HeroUI cobre cabeçalho compacto, KPIs identificados como itens carregados, filtros por gravidade, paginação, timeline, detalhes recolhidos e estados loading/vazio/erro/autorização.
- `F1-658-007`: não há select HTML, storage acadêmico no browser, criação/comparação de anos, DML acadêmico, mudança de regra ou autoridade.
- `F1-658-008`: testes direcionados, `npm run verify`, CI do head, revisão, merge/deploy e smoke somente leitura seguem BN-DEC-023; validação visual conjunta continua separada.
- `F1-658-009`: a Auditoria persistida retém somente `blocking-error` e `above-maximum`; warnings técnicos/esperados permanecem fora do snapshot corrente sem enfraquecer a validação/preflight da importação.

## F14-662 — Recuperação lógica e contenção PostgreSQL

- `F14-662-001`: parser aceita somente envelope/catálogo/conjunto exatos do backup V2 e nunca publica payloads em falhas.
- `F14-662-002`: alvo precisa ser loopback, vazio e nomeado `gradebook_recovery_*`; utilitário não contém DROP nem login/senha.
- `F14-662-003`: plano aplica `0001`, grants, `0003`, `0004`, `0005`; `0002`, já incorporada à baseline reconstruída, não é reaplicada.
- `F14-662-004`: restore local confere 28 relações/120.879 linhas e 12 sequences, preservando IDs, binários, JSON, nulos e timestamps.
- `F14-662-005`: postflight confere catálogo 29/227/203/62/51, quatro funções, três triggers, FKs válidas, `PUBLIC` zero, 2026 único e zero boletins inventados.
- `F14-662-006`: banco recuperado serve catálogo, comparação T2×T1, Auditoria, Conselho e histórico de Boletins sem emissão.
- `F14-662-007`: duas conexões provam espera no advisory lock e último snapshot de diagnósticos completo, sem mistura.
- `F14-662-008`: falha intencional após DELETE reverte a transação e preserva o conjunto diagnóstico anterior.
- `F14-662-009`: corrida SERIALIZABLE do Conselho repete uma vez SQLSTATE 40001; CAS resulta em um vencedor, um `version-conflict` e retry idempotente.
- `F14-662-010`: massa sintética é removida; backup/restore gerenciado, RPO/RTO, configurações externas, piloto e visual permanecem explicitamente fora do aceite.

## F14-664 — Retirada seletiva da Auditoria V1

- `F14-664-001`: `GradebookAuditSurface` monta exclusivamente a Auditoria Atual V2 e o cliente ativo consulta somente `/api/gradebook/import-diagnostics` com `no-store`.
- `F14-664-002`: página, cliente e painel da Auditoria V1 sem chamadores são removidos em vez de permanecerem como fallback oculto.
- `F14-664-003`: o roteador genérico não importa nem despacha o handler dedicado `/api/gradebook/audit-workspace` aposentado.
- `F14-664-004`: o núcleo `createAuditWorkspaceV1`, contrato e source D1 continuam preservados porque Relatórios V1 ainda os consome internamente.
- `F14-664-005`: nenhuma relação, diagnóstico atual, importação, correção automática, regra, autoridade, segredo ou infraestrutura é alterada.
- `F14-664-006`: testes focados, `npm run verify`, CI do head, revisão, merge/deploy e smoke somente leitura seguem BN-DEC-023; visual conjunto continua separado.

## F14-666 — Retirada dos frontends antigos não montados

- `F14-666-001`: shell e wrappers montam somente as superfícies relacionais atuais de Centrais, Desempenho, Conselho, Boletins e Relatórios.
- `F14-666-002`: 19 módulos frontend antigos sem import de produção são removidos, incluindo o helper de ano substituído pelo contexto fixo 2026.
- `F14-666-003`: handlers, endpoints, contratos, serviços, adapters e migrations permanecem; compatibilidade server-side não é inferida como morta pela ausência de frontend.
- `F14-666-004`: `bulletin-pdf-renderer-v1.ts` permanece e continua sendo importado pelo V2; somente ações V1 sem chamadores são retiradas.
- `F14-666-005`: regressões de integração apontam para páginas/hooks atuais e não recriam testes das implementações removidas.
- `F14-666-006`: não há DDL/DML, regra, autoridade, ano adicional, comparação entre anos, segredo, binding ou configuração de produção.
- `F14-666-007`: testes focados, `npm run verify`, CI do head, revisão, merge/deploy e smoke somente leitura seguem BN-DEC-023; visual conjunto continua separado.

## F2-668 — Medições autenticadas do Desempenho

- `F2-668-001`: cenário fixa 2026/T1/Regular/Resultado e registra apenas contagens sanitizadas, sem nomes, IDs, notas ou payloads.
- `F2-668-002`: dashboard e detalhe recebem três aquecimentos e 20 amostras sequenciais; todas retornam HTTP 200, `ready` e `no-store`.
- `F2-668-003`: dashboard observa p95 441,3 ms e 6.569 B Brotli; passa p95 ≤600 ms e payload inicial ≤500 KB compactados.
- `F2-668-004`: detalhe observa p95 193,5 ms e 1.284 B Brotli; passa p95 ≤400 ms.
- `F2-668-005`: matriz observa 675,7 ms do clique até três widgets utilizáveis, sem alerta; passa ≤2 s no cenário.
- `F2-668-006`: evidência é pontual, não SLA universal, e não substitui visual/acessibilidade manual ou piloto integral.
- `F2-668-007`: documentação não altera runtime, DDL/DML, dados, schema, regras, autoridade, ano, binding, segredo ou infraestrutura.

## F1-674 — Trilha humana durável da Auditoria

- `F1-674-001`: contrato aceita somente 2026 e as ações `RECONHECIDO` sem texto ou `ANOTAÇÃO` com 3–2.000 caracteres.
- `F1-674-002`: migration acrescenta uma relação vazia, sem backfill/UPDATE/DELETE/TRUNCATE e sem FK destrutiva para o snapshot corrente.
- `F1-674-003`: apagar um diagnóstico atual não apaga sua trilha; a leitura passa a classificá-lo como fora das pendências.
- `F1-674-004`: ator vem do OID autenticado, horário vem do banco e retry com a mesma chave é idempotente; reutilização divergente conflita.
- `F1-674-005`: contexto consulta até 200 identidades em lote; histórico pagina até 100 por cursor estável `(registrado_em, id)`, sem salto/duplicação por nova ação; nenhum caminho faz consulta por achado.
- `F1-674-006`: somente a role backend tem `SELECT, INSERT`; sem `UPDATE/DELETE`, acesso público/cliente, cache ou confiança em ator do payload.
- `F1-674-007`: UI HeroUI reconhece/anota, mostra timeline contextual e histórico sob demanda; falha da trilha não esconde a lista atual.
- `F1-674-008`: não há botão de resolver/ignorar/descartar, correção automática, alteração acadêmica ou mudança de autoridade.
- `F1-674-009`: BN-DEC-027 autorizou o DDL em 11/09/2026 e `0006` foi aplicada/postvalidada em produção; o código dependente continua condicionado à integração/publicação da PR #675, aberta e fora de draft.
- `F1-674-010`: após autorização, dump privado novo abre em `pg_restore`, restaura as 29 relações e mantém contagens produtivas em PostgreSQL local descartável.
- `F1-674-011`: preflight remoto exige baseline `29/227/203/62/51`, 12 sequências, somente 2026, zero FK inválida e relação-alvo ausente.
- `F1-674-012`: postflight de `0006` exige catálogo `30/246/218/66/52`, 13 sequências, relação vazia `19/15/4/1`, ACL backend `SELECT/INSERT`, zero acesso cliente/público e contagens acadêmicas inalteradas.
- `F1-674-013`: Advisor de segurança não introduz alerta; índices da relação vazia podem aparecer apenas como informativos ainda não usados.

## CAT — Cadastro acadêmico pela importação

- `CAT-001`: professor e ano são reconhecidos em `CONFIGURAÇÃO!A2/C2`.
- `CAT-002`: listas 1º/2º/3º divergentes falham sem escrita.
- `CAT-003`: o mesmo estudante/matrícula é reutilizado entre trimestres e componentes da turma.
- `CAT-004`: `REC` referencia somente nome oficial único; não cria estudante.
- `CAT-005`: `VG` não participa do cadastro nem da contagem oficial.
- `CAT-006`: IDs técnicos são emitidos no servidor e não atravessam o request V5.
- `CAT-007`: cadastros e registros acadêmicos confirmam ou revertem juntos.
- `CAT-008`: somente o ano letivo 2026 é aceito pela importação canônica; outro ano falha antes da persistência e não existe criação administrativa de anos.

## REL — Release

- `REL-001`: `npm run verify` aprovado no SHA do PR.
- `REL-002`: merge somente depois dos critérios de aceite.
- `REL-003`: workflow de produção aprovado no SHA da `main`.
- `REL-004`: rota/fluxo novo verificado no site oficial.
- `REL-005`: issue, fase e `PROJECT_STATE.yaml` atualizados pelo integrador.
- `REL-006`: recurso incompleto não aparece como disponível.

## F16-833 — Perspectiva Alunos e seletores de entidade

- `F16-833-001`: Aluno, Componente e Professor mantêm o `Select` HeroUI v3 real e não modal; abrem, reabrem e fecham por clique/toque externo, Escape e seleção.
- `F16-833-002`: Escape devolve foco ao gatilho; a seleção chama somente o callback da entidade e fecha o listbox.
- `F16-833-003`: Alunos apresenta desempenho atual, evolução trimestral, atenção recorrente, participação avaliada, trajetória, quantitativo × qualitativo, destaques, recorrências e a tabela completa de componentes usando o mesmo snapshot V6/`learning`.
- `F16-833-004`: período, destaques, recorrências e componentes reutilizam os callbacks de navegação/detalhe existentes, sem consulta adicional na navegação interna.
- `F16-833-005`: revalidação do mesmo recorte preserva DOM, foco e estado local; mudança de período ou aluno remonta o painel e recolhe os detalhes técnicos.
- `F16-833-006`: recortes vazios, parciais ou sem base comparável mostram `—`/mensagem de insuficiência; ausência não vira zero, participação não vira presença e nota baixa isolada não vira recorrência.
- `F16-833-007`: REC e cobertura ficam recolhidas; resultado anual e Conselho só aparecem no recorte anual quando disponíveis.
- `F16-833-008`: Turmas, Componentes e Professores preservam o vocabulário estatístico anterior; esta entrega não declara uniformização dessas perspectivas nem altera contrato, SQL, pesos, máximos, arredondamento, schema, persistência ou ACL.
- `F16-833-009`: validação interna automatizada e validação manual do usuário são evidências distintas; nenhuma conferência visual é inferida de testes React ou deploy.

## RDY — Readiness F9 sem ativação

- `RDY-001`: preparação completa mantém todos os hard stops produtivos explícitos.
- `RDY-002`: autoridade alterada, binding presente, migration remota ou piloto real são violações de
  escopo, nunca evidência de readiness.
- `RDY-003`: lote máximo de 50 workbooks sintéticos permanece bounded e sequencial.
- `RDY-004`: baseline `0001` e extensões `0003`–`0005` recuperam o catálogo atual de 29 tabelas; `0002` já está incorporada e migrations não idempotentes falham diante de reexecução/drift.
- `RDY-005`: 30 séries sintéticas de Boletim preservam duas versões e sobrevivem a restart.
- `RDY-006`: fila sintética de 30 estudantes resolve versões em lote e CAS concorrente tem um vencedor.
- `RDY-007`: falha entre raiz/versão faz rollback sem versão órfã e mantém histórico recuperável.
- `RDY-008`: produção recusa antes de consultar binding mesmo quando ele é apresentado.
- `RDY-009`: plano de smoke futuro é inerte, usa nenhum dado ou dados sintéticos e não aplica migration.
- `RDY-010`: protocolo privado não publica nomes, notas, hashes, caminhos, payloads ou IDs remotos.

## W21 — Integração da fidelidade de avaliações

- `W21-001`: recognizer separa R3/S3 e AA3:AJ4 dos estudantes iniciados na linha 5.
- `W21-002`: materialização produz R/S genéricos e associa R/S/AA:AJ somente ao slot correto.
- `W21-003`: definição incompleta preserva evidência sem máximo zero, componente ou GradeEntry órfão.
- `W21-004`: planejador/executor/CAS/transação oficiais permanecem o único fluxo de promoção.
- `W21-005`: T/Z/AK/AM/AN, perfil 2026, 30/30/40, 45/55 e arredondamento não mudam.
- `W21-006`: Desempenho mantém seis queries, comparação fail-closed e projeção fiel dos componentes.
- `W21-007`: Boletins/Relatórios preservam componentes V1/V2 e reprint histórico sem leitura atual.
- `W21-008`: readiness V1 histórico segue `prepared-for-manual-authorization`; o catálogo corrente reconhece migrations 0001–0005 sem reinterpretar os cinco hard stops históricos.

## F2-646 — Fonte, ano global e composição desktop

- `F2-646-001`: ordinal qualitativo vazio/impresso sem máximo e sem nota não cria atividade, coluna, aviso ou denominador.
- `F2-646-002`: máximo, zero, valor indisponível persistido, descrição real e nota de outro aluno preservam o instrumento e o histórico.
- `F2-646-003`: sigla vem somente de `CONFIGURAÇÃO`/`CONFIGURAÇÕES!H3:I16`; componente desconhecido não recebe abreviação inventada.
- `F2-646-004`: supersedido pela #649: o shell usa 2026 fixo, sem catálogo de escolha, seletor ou preferência persistida.
- `F2-646-005`: Importação não recebe seletor global e rejeita qualquer fonte fora de 2026 antes da persistência.
- `F2-646-006`: contratos V1 recebem apenas correspondência única/exata do ano numérico; ausência, duplicidade ou vizinhança fecham o mapeamento.
- `F2-646-007`: detalhe preserva zero/parcial/N-C/REC e recebe elegibilidade de paralela e REC final como sinais independentes do núcleo.
- `F2-646-008`: Tabs HeroUI, quatro lentes, matriz compartilhada, gráfico investigável e controles desktop mantêm um request por seleção, não por aluno.
- `F2-646-009`: o campo V2 histórico permanece fail-closed; a comparação trimestral posterior usa contrato V4 separado da #649.
- `F2-646-010`: `npm run verify`, CI do head final, revisão, merge e deploy seguem BN-DEC-023; validação visual adiada não é registrada como aprovada.

## F12-649 — 2026 fixo e comparação trimestral V4

- `F12-649-001`: superfície, cliente, contrato e serviço de criação de anos não existem mais no produto ativo.
- `F12-649-002`: shell/Centrais/Desempenho não exibem seletor nem usam catálogo/sessionStorage; todo request ativo leva 2026.
- `F12-649-003`: Centrais V2, Desempenho V2/V3/V4 e importação V9 rejeitam outro ano antes de SQL/DML.
- `F5-660-001`: Centrais, Desempenho, Boletins e projeção anual apresentam P, M, H, G, C e os demais componentes na ordem observada na configuração da fonte; desconhecidos ficam depois sem posição inventada.
- `F5-660-002`: Central docente usa somente V2 relacional/2026, HeroUI Select e fatos importados, sem select HTML escrito pela aplicação ou arraste de colunas.
- `F5-660-003`: todo payload `maintenanceVersion: 1` é recusado depois de auth e antes de instanciar/tocar o runtime legado; V2 continua read-only/repeatable-read e sem DML.
- `F12-649-004`: T2 aceita somente T1; T3 aceita T1/T2; T1, Visão geral e Avaliações não oferecem comparação.
- `F12-649-005`: compara o mesmo aluno/turma/componente/lente/modo por `valor/máximo oficial positivo` e relação racional exata.
- `F12-649-006`: diferença é em pontos percentuais; zero é comparável, igualdade é zero exato e valor acima de 100% não é limitado.
- `F12-649-007`: excluído, parcial, vazio, N/C, REC pendente, não aplicável, indisponível ou sem máximo positivo resulta indisponível com motivo.
- `F12-649-008`: resposta declara `descriptive-observation`; não contém tendência, ranking, tolerância, melhora/piora ou emissão oficial.
- `F12-649-009`: atual e referência usam uma transação read-only/repeatable-read, um carregamento de fatos e até seis instruções, sem N+1.
- `F12-649-010`: cliente valida alinhamento/grupos, usa no-store, mantém seleção em memória e cancela/descarta resposta obsoleta.
- `F12-649-011`: testes usam somente massa sintética/de teste; seu conteúdo não é evidência acadêmica oficial.
- `F12-649-012`: validação visual de FINAL-1/FINAL-2 continua pendente e será anunciada antes da sessão única com o responsável.

## F13-676 — Anos materializados e R/R

- `F13-676-001`: Relação 2025 materializa o ano; notas 2025 sem Relação são bloqueadas e reimportação idêntica não duplica contexto.
- `F13-676-002`: bootstrap retorna todos os anos materializados, mais recente primeiro; troca global invalida as leituras e não persiste preferência no browser.
- `F13-676-003`: aluno nominalmente igual em 2025/2026 possui IDs, vínculos, notas e resultados distintos; consultas cruzadas falham fechadas.
- `F13-676-004`: `R/R` é reconhecido somente em REC, persiste em máscara própria disjunta de `N/C` e produz histórico com estado 3.
- `F13-676-005`: qualquer `R/R` em qualquer componente produz `REPROVADO` e `not-eligible`; não entra na fila nem aceita decisão/voto de Conselho.
- `F13-676-006`: Boletins, PDFs, Desempenho e Relatórios preservam `R/R` e o resultado terminal sem exigir U oficial inexistente para esse caso.
  A regressão de #684 também comprova emissão/reimpressão com AM oficial preservada apesar de composição calculada incompleta, presença na matriz/relatório de Recuperação e bloqueio mantido para o mesmo recorte sem R/R.
- `F13-676-007`: comparação permanece somente entre trimestres do mesmo ano; nenhum contrato oferece comparação interanual.
- `F13-676-008`: migration 0007 é aditiva, sem backfill/DML destrutivo, e passa replay, constraints, drift/ACL e Advisor.
- `F13-676-009`: piloto privado percorre importação, movimentações, recuperação, Conselho, votos, fechamento, boletins e relatórios com massas de teste, sem publicar PII.

## F15-688 — Configurações e reset anual

- `F15-688-001`: o shell e a busca montam uma única aba Configurações atual, sem fallback ou tela legada.
- `F15-688-002`: prévia aceita somente ano materializado e retorna contagens de todas as 30 relações atribuíveis, revisão e frase `RESETAR <ano>`.
- `F15-688-003`: execução exige confirmação de irreversibilidade, frase exata e revisão ainda vigente; mudança desde a prévia retorna conflito sem DML.
- `F15-688-004`: reset usa uma transação serializável e bloqueio do conjunto; falha injetada depois de exclusões reverte todas.
- `F15-688-005`: cadastro, notas, históricos, diagnósticos/tratamentos, Conselho e boletins do ano são removidos; diagnóstico sem ano, schema, sequências e outros anos permanecem.
- `F15-688-006`: ano removido sai do bootstrap e pode ser materializado novamente pela Relação, com novas identidades anuais.
- `F15-688-007`: HTTP exige autenticação, `gradebook.persistence.admin`, mesma origem, body bounded, provider/gate e `no-store`; falha é opaca.
- `F15-688-008`: ACL acrescenta somente `DELETE` às dez relações append-only necessárias; não concede `ALL`, `TRUNCATE`, DDL ou acesso público/cliente.
- `F15-688-009`: `vinculo.situacao = NULL` é apresentado como chip `Em curso` na matriz, sem mudar dado persistido ou regra acadêmica.
- `F15-688-010`: testes focados, `npm run verify`, CI do head, revisão, merge/deploy e smoke seguem BN-DEC-023; smoke não confirma reset produtivo.

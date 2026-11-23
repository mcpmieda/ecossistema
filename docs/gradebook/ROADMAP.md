# Roadmap — quatro fases finais

> Retirada solicitada em 10/10/2026: a candidata remove a aba Relatórios e seu módulo institucional V1/V2. O endpoint antigo responde 410 autenticado; Desempenho/PDF docente, Conselho, Auditoria e Boletins permanecem. [Escopo e consumidores](REPORTS_RETIREMENT_20261010.md). Entrega em branch/PR rascunho, sem integração ou publicação.

A reconstrução de persistência da #613 e as quatro fases finais terminaram. Este roadmap preserva a fila executada e não apaga evidências anteriores. O fechamento factual está em [FINAL4_PILOT_406.md](FINAL4_PILOT_406.md) e [FINAL_OPERATION_596.md](FINAL_OPERATION_596.md).

## FINAL-1 — #633: runtime relacional e verdade documental

**Entregar:** fonte única documentada, baseline SQL mínima reproduzível, leitura compartilhada em lote e consumidores coerentes com fatos/motor relacionais. Identificar cada rota, fábrica, SQL, contrato e lacuna no `CONSUMER_MAP.md`. Não classificar legado só pelo nome.

**Primeira entrega / PR #636:** reancoragem documental e leitura em lote; projeção anual deixa de consultar fatos separadamente por oferta. Preserva motor e resultados. Não liga novas telas nem fecha toda a fase.

**Blocos concluídos:** baseline, Centrais, Desempenho, Conselho, Boletins, Relatórios, Auditoria atual e trilha humana, configuração docente, recuperação/contenção local e retiradas seletivas estão integrados e publicados. Recuperação gerenciada externa foi explicitamente adiada; não é declarada como implementada.

**Fechar quando:** consumidores contemplados estejam integrados e verificados, sem relações antigas no caminho migrado, com CI e evidência funcional após publicação autorizada.

## FINAL-2 — #634: Desempenho completo

Implementar o contrato `PAINEL DESEMPENHO`: turma/período T1–T3/Visão geral; Regular/Recuperação; matriz dominante Nº/Situação/Aluno/componentes; quatro lentes; poucos KPIs e um gráfico contextual; investigação; comparação proporcional T2→T1 e T3→T1/T2 declarada pela #649; detalhes sob demanda. Naquele checkpoint, o contexto estava fixo em 2026; a #676 posteriormente acrescentou seleção anual global e isolamento, sem comparação entre anos. Dados exibidos não são automaticamente população elegível de indicadores. Não criar regras, conceitos qualitativos ou métricas sem semântica sustentada.

Concluída e encerrada. A #668 mediu no browser autenticado o payload, p95 de dashboard/detalhe e matriz utilizável e aprovou as metas no cenário sanitizado; isso não vira SLA universal. A rodada manual posterior gerou os refinamentos #672/#673 e sua aceitação encerrou a #634. Piloto integral e autoridade continuam pertencendo a #406/#347.

## FINAL-3 — #635: Conselho definitivo

A decisão #648 fixa 2026, os estados 1/2/3, voto opcional somente favoráveis/contrários e desempate do diretor fora do sistema. O V3 relacional entrega turma/aluno, fila, panorama/detalhes, não elegíveis com motivos, sessão, decisão humana, votação, fechamento e reabertura. Não converte julgamento humano em cálculo nem infere diretor a partir de papel administrativo.

A extensão mínima persistia sessão, idempotência, votos, históricos e fotografias de fechamento sem backfill ou mudança de fatos acadêmicos. CI, migration/postflight, publicação e smoke da #648/#653 estão verdes; a #662 comprovou restart/restauração e contenção CAS em PostgreSQL local. Aceite visual conjunto e piloto anual foram concluídos posteriormente, sem registrar voto de minerva do diretor. Em 23/11/2026 a BN-DEC-049 (#1558) retirou linha do tempo, históricos, fotografias e a justificativa de abrir, fechar e reabrir: o Conselho guarda só o estado atual. A migration `0023`, que remove essas tabelas, aguarda aplicação em produção.

## FINAL-4 — #406: piloto do produto inteiro

Reutilizar evidência da #613; testar o que é novo/regressão e todas as jornadas reais: importação/Auditoria, contexto/pesquisa/centrais, Desempenho, Conselho, emissão/reimpressão e Relatórios. Incluir autorização, no-store, falhas, concorrência, recuperação e medidas de capacidade. Arquivar apenas legado sem consumidores, sem excluir recurso produtivo automaticamente.

**Fechar quando:** matriz sanitizada requisito/caso/resultado/commit verde, divergências materiais reconciliadas e recuperação comprovada. Código/testes sintéticos não substituem esse piloto.

Concluída pela #406/PR #686. O corpus descartável de 2025 permitiu exercitar o ano completo, enquanto o corpus canônico de 2026 preservou a prova de importação/reimportação idêntica. A recuperação local foi comprovada; backup externo/RPO/RTO permanece como risco aceito e adiado.

## Aceite e entrega

#347 foi encerrada com `imported-source` oficial nos consumidores atuais e `native-engine` descritivo. #596 consolida operação, runbook, limitações e aceite institucional. #220 continua expansão transversal de observabilidade; falhas críticas bloqueiam quando demonstradas, recursos extras planejados não.

## Continuidade histórica

F0–F9 e ondas anteriores continuam registradas em [roadmap preservado](history/pre-final-1/ROADMAP.md). #185/#192 foram substituídas como filas; integridade, durabilidade, segurança e recuperação foram transferidas, não dispensadas. F1 = 7/7 permanece evidência histórica, não prova de todos os painéis no schema novo.

Uma entrega termina somente após testes, integração/publicação autorizadas e verificação aplicável. Não reduzir artificialmente o restante a um percentual de conclusão sem critérios mensuráveis.

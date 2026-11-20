# Relatórios institucionais relacionais V2 — #656

> Retirada solicitada em 10/10/2026: a candidata remove a aba Relatórios e seu módulo institucional V1/V2. O endpoint antigo responde 410 autenticado; Desempenho/PDF docente, Conselho e Auditoria permanecem; a aba Boletins foi removida depois, em 20/11/2026. [Escopo e consumidores](REPORTS_RETIREMENT_20261010.md). Entrega em branch/PR rascunho, sem integração ou publicação.

O conteúdo abaixo registra o checkpoint histórico; não declara esses consumidores ativos na candidata.

## Escopo e estado factual

A #656/PR #657 substituiu a página ativa de Relatórios V1 por uma composição V2 das fontes relacionais vigentes. A implementação partiu de `main@1512d5b37c42931b1df81bbfe6483d1ad5340130`, foi integrada em `3d762d7412fe0a5760680566ae6739f4d10c1172` e publicada pelo deploy 264 (`34577894561`). O `npm run verify` final passou com 1.486 testes; a CI do head e o smoke autenticado somente leitura ficaram verdes.

O contrato está em `shared/gradebook-contracts/reports/relational-institutional-reports-v2.ts`; o endpoint continua `POST /api/gradebook/reports` e distingue `contractVersion: 2`. O ano é literalmente 2026. Não existe seleção, criação ou comparação de anos.

## Cadeia e autoridade

| Operação           | Cadeia V2                                                                                                     | Autoridade preservada                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `catalog`          | serviço de Relatórios → catálogo do Boletim V2 → turma/alunos relacionais                                     | identidade e ordem canônica da fonte                            |
| `performance`      | serviço de Relatórios → Desempenho V3 ou comparação V4 → projeção relacional em lote                          | cálculo simplificado como leitura; comparação apenas descritiva |
| `council`          | serviço de Relatórios → Conselho V3 → fatos e sessão relacionais                                              | decisão humana explícita; elegibilidade não vira decisão        |
| `audit`            | serviço de Relatórios → `relational-import-diagnostics-read-v2` → `importacao_diagnostico` + cadastros atuais | achado atual, não correção nem histórico acadêmico inventado    |
| `bulletin-history` | serviço de Relatórios → Boletim V2 → `boletim_snapshot`                                                       | sequência imutável emitida                                      |
| `bulletin-reprint` | serviço de Relatórios → Boletim V2 → snapshot selecionado                                                     | snapshot-only; não relê fatos atuais                            |

As operações V2 são somente leitura. O endpoint usa POST por compatibilidade do transporte, mas o caminho de relatório não executa `INSERT`, `UPDATE`, `DELETE` ou `TRUNCATE`. A entrega não altera schema, dados, importação, regras acadêmicas, binding ou autoridade oficial.

## Semântica funcional

Desempenho oferece famílias Resultado da turma, Composição e Recuperação, com lentes Resultado, Quantitativo e Qualitativo conforme a combinação válida. T2 pode comparar com T1; T3, com T1 ou T2; Visão geral não compara. A comparação usa o contrato V4 e não cria tendência, ranking ou tolerância. Investigação detalhada por avaliação exige oferta explícita e continua na área Desempenho, em vez de ser fabricada como relatório transversal.

Conselho usa exatamente `APROVADO PELO CONSELHO`, `REPROVADO PELO CONSELHO` e `REPROVADO POR FALTA`. Apenas votos favoráveis e contrários são armazenados/exibidos; presentes é derivado. Diretor, desempate e voto de minerva permanecem fora do sistema.

Auditoria separa achados atuais da explicação de tratamento humano. Um achado corrigido deixa a lista atual pelo fluxo transacional de sua origem; isso não autoriza apagar automaticamente vestígio humano, editar a fonte silenciosamente ou aplicar correção automática. A timeline V2 apresenta a evidência disponível sem fingir um log histórico que o schema atual não possui.

Histórico e reimpressão de Boletins usam exclusivamente snapshots V2. Relatórios não emite nova versão. PDF continua responsabilidade do cliente de Boletins a partir do snapshot validado.

## Limites e falha fechada

O contrato limita catálogo a 100 turmas, matrizes a 150 alunos, 40 ofertas e 1.000 pares, diagnósticos a 100 itens por página e operações de Boletim a 50 alunos. IDs são inteiros positivos. Respostas declaram `ready`, `invalid-request`, `not-authorized`, `not-found`, `scope-too-large` ou `unavailable`; indisponibilidade nunca vira correspondência.

HTTP exige identidade Entra, capacidade `gradebook.persistence.admin`, origem oficial, provider PostgreSQL e `Cache-Control: no-store`. O cliente cancela ou descarta respostas obsoletas e não persiste dados acadêmicos no browser. V1 permanece apenas como compatibilidade não montada e não é fallback de V2.

## Interface e evidência

A página V2 usa HeroUI com filtros estáveis em grade responsiva, cabeçalho compacto, KPIs discretamente coloridos, tabelas relacionais e timeline. Não contém o card grande “Banco de Notas”, select HTML visível no código nem ordenação manual por arraste. A validação estrutural local foi executada com BrowserAct sobre a configuração real de Vite/Tailwind e massa sintética; o aceite visual conjunto continua deliberadamente adiado e será anunciado antes da sessão única com o responsável.

Testes cobrem schema estrito, serviço, HTTP, cliente/UI, isolamento da montagem V1, adapter SQL e integração PostgreSQL em PGlite com baseline atual. A integração valida ordem canônica, respostas de todas as famílias, limites e ausência de DML. A #662 acrescentou leitura dessas famílias após restore e contenção PostgreSQL multi-sessão local. Isso não substitui CI do head, smoke autenticado publicado, restore gerenciado/política RPO-RTO, piloto #406 ou aceite acadêmico #347.

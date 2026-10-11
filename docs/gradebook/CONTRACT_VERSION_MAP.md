# Mapa canônico de versões de contratos — BN-03

## Extensão candidata — #1269 / #1276

`shared/student-identity/reconciliation-v1.ts` é contrato novo da entrega em branch, consumido por Relatório, Alunos e o orquestrador central. Normalização V1 é compartilhada com Relação V9. O transporte V9 ganha somente `warnings` aditivo para grafia em movimentação segura; reset V1 ganha contagem `reconciliation`. Os comandos antigos `birth-write`/`birth-batch` permanecem como tombstones autenticados, sem escritor produtivo. [Contrato e condição de retirada do legado](../student-identity/RECONCILIATION_V1.md). Essa extensão não declara publicação ou substituição da baseline produtiva.

Data da varredura: 20/09/2026. Baseline: `main@6800d18ee3c7fdd6042076d7e4dc51962ba45a5a` (já inclui #964/#965).

Este documento classifica **vigência de código**, não idade de arquivo. O maior sufixo `vN` não é, por si só, a fonte de verdade.

## Estados

- **CURRENT** — participa diretamente de um caminho funcional vigente.
- **COMPATIBILITY** — continua necessário porque um contrato CURRENT o compõe/importa, uma rota vigente ainda o expõe, ou existe consumidor de compatibilidade deliberadamente preservado.
- **HISTORICAL/MEMORY** — não participa de caminho executável atual; pode permanecer apenas como memória até uma issue de retirada provar ausência de consumidor.
- **CURRENT-ADDITIVE** — versão nova que acrescenta uma capacidade paralela sem substituir a versão anterior inteira.

Buscas de consumidor neste mapa **excluem `Aprendizados/**` como autoridade operacional**. Referências apenas em `Aprendizados/**` não tornam um módulo vigente.

## 1. Import persistence transport

| Artefato | Estado | Consumidores vivos observados | Evidência/testes | Condição de retirada |
| --- | --- | --- | --- | --- |
| `import-persistence-transport-v1.ts` | COMPATIBILITY | base importada por v2/v3/v4 e tipos ainda usados na cadeia de source/import | testes de source/result/persistence | somente após retirar todos os derivados que importam v1 |
| `import-persistence-transport-v2.ts` | COMPATIBILITY | v3/v4/v9 | cadeia de importação V9 | somente após v9 e derivados deixarem de importar seus tipos |
| `import-persistence-transport-v3.ts` | COMPATIBILITY | v4, `spreadsheet-recognizer.ts`, `academic-result-projection-v1.ts` | testes de projeção/source | migrar consumidores diretos antes |
| `import-persistence-transport-v4.ts` | COMPATIBILITY | v5, `canonical-import-v9.ts`, diagnósticos e recognizer | testes de importação atuais | migrar consumidores diretos antes |
| `import-persistence-transport-v5.ts` | COMPATIBILITY | v6 | cadeia de transportes | retirar somente após v6 deixar de depender |
| `import-persistence-transport-v6.ts` | COMPATIBILITY | v7/v8 | cadeia V8 | retirar somente após v8 e eventual v7 saírem |
| `import-persistence-transport-v7.ts` | HISTORICAL/MEMORY | **nenhum consumidor vivo encontrado fora de `Aprendizados/**`** | referências encontradas só no arquivo histórico D1-V8 | BN-04 deve revalidar e só então remover/mover |
| `import-persistence-transport-v8.ts` | COMPATIBILITY | `spreadsheet-recognizer.ts`; compõe tipos pré-V9 | testes de recognizer/import | migrar o consumidor direto e dependências primeiro |
| `import-persistence-transport-v9.ts` | **CURRENT** | client V9, API `import-persistence`, V9/V10/V11, canonical import, batch/import hooks | `relational-v9-contract`, multiyear, revisions, PostgreSQL | só por nova decisão de contrato explícita |

**Interpretação:** v1–v6/v8 não são “código morto” apenas por terem número menor. V9 é a fronteira externa atual, mas reutiliza tipos das versões anteriores.

## 2. Source contracts

| Artefato | Estado | Consumidores vivos | Condição de retirada |
| --- | --- | --- | --- |
| `source-contract-v1.ts` | COMPATIBILITY/Core | manifest, import-contract, interpretador de célula, transportes e projeções | exige migração ampla do vocabulário de origem |
| `source-contract-v2.ts` | COMPATIBILITY | v3/v4, canonical import, diagnostics, materializers | retirar só após esses consumidores |
| `source-contract-v3.ts` | COMPATIBILITY | v4 e materializer v3 | retirar após prova de que materializer v3 não é consumidor vigente e v4 não depender |
| `source-contract-v4.ts` | **CURRENT** | assessment materializer v4 e contrato de source vigente | nova versão expressamente substituta |
| `source-values-contract-v5.ts` | **CURRENT-ADDITIVE** | interpretação de célula, audit/results, adapters de importação | não é substituto simples de v4; remover só após migrar vocabulário de valores |

## 3. Result contracts

| Artefato | Estado | Consumidores vivos | Condição de retirada |
| --- | --- | --- | --- |
| `results-contract-v1.ts` | COMPATIBILITY/Core | domínio, readiness, boletins, conselho, performance, persistence ports | migração de todo o núcleo que usa os tipos base |
| `results-contract-v2.ts` | COMPATIBILITY | v3, materializers, performance/bulletins | retirar após migrar consumidores |
| `results-contract-v3.ts` | **CURRENT** | source v4, materializer v4, performance/persistence ports | nova versão substituta explícita |

## 4. Serviço relacional de importação

| Serviço | Estado | Papel atual |
| --- | --- | --- |
| `import-relational-service-v9.ts` | COMPATIBILITY/Core | implementação relacional base; V10 a envolve |
| `import-relational-service-v10.ts` | COMPATIBILITY | wrapper de filtragem/coordenação; V11 a envolve |
| `import-relational-service-v11.ts` | **CURRENT** | composição atual chamada por `functions/api/gradebook/import-persistence.ts` |

A cadeia é deliberadamente **V11 → V10 → V9**. Não remover V9/V10 sem reescrever V11 e seus testes.

## 5. Operational workspace

| Contrato | Estado | Consumidores |
| --- | --- | --- |
| `operational-workspace-transport-v1.ts` | COMPATIBILITY/DTO | #1079: somente validacao e resposta de retirada HTTP 410, sem runtime D1 |
| `operational-workspace-transport-v2.ts` | **CURRENT** | year context/provider, Centro BN V2, contas Portal admin e rota V2 |

A #1079 autoriza explicitamente a retirada operacional V1 em todos os ambientes.

## 6. Performance

Estas versões representam **capacidades aditivas**, não uma fila em que V6 invalida V2–V5.

| Contrato | Estado | Papel |
| --- | --- | --- |
| `performance-transport-v1.ts` | COMPATIBILITY/DTO | #1079: somente validacao e resposta HTTP 410; tipos base reutilizados preservados |
| `relational-performance-v2.ts` | **CURRENT** | base relacional de performance |
| `performance-analysis-v3.ts` | **CURRENT-ADDITIVE** | análise descritiva |
| `performance-term-comparison-v4.ts` | **CURRENT-ADDITIVE** | comparação trimestral |
| `performance-dashboard-v5.ts` | **CURRENT-ADDITIVE** | widgets/dashboard |
| `performance-analytics-v6.ts` | **CURRENT-ADDITIVE** | perspectivas analíticas/exports atuais |

## 7. Conselho

| Contrato | Estado | Consumidores |
| --- | --- | --- |
| `council-workspace-contract-v1.ts` | COMPATIBILITY/Core | #1079: transporte V1 retorna 410; tipos/dominio compartilhados preservados |
| `council-institutional-contract-v2.ts` | COMPATIBILITY/Core | #1079: transporte V2 retorna 410; tipos/dominio compartilhados preservados |
| `relational-council-v3.ts` | **CURRENT** | UI/HTTP/service relacional e Relatórios V2 |

A #1079 retira a execucao HTTP V1/V2, nao todos os tipos que essas versoes compoem.

## 8. Boletins

| Contrato | Estado | Consumidores |
| --- | --- | --- |
| `bulletin-transport-v1.ts` / `bulletin-contract-v1.ts` | COMPATIBILITY/Core | #1079: transporte V1 retorna 410; apresentacao/PDF reutilizados preservados |
| `relational-bulletin-v2.ts` | **CURRENT** | UI, HTTP e snapshot PostgreSQL de Boletins |

Snapshots já emitidos continuam históricos e não são reinterpretados por troca de contrato.

## 9. Relatórios

Contratos institucionais V1/V2 e seus consumidores exclusivos retirados nesta candidata. Apenas o endpoint de compatibilidade autenticado retorna `{ state: 'retired' }`/410, sem dependência desses contratos. [Mapa de retirada](REPORTS_RETIREMENT_20261010.md).

## 10. Regra para versões futuras

1. Nova versão deve declarar se **substitui**, **envolve** ou **acrescenta** capacidade.
2. A versão anterior só vira HISTORICAL quando não houver import/rota/teste/consumer vigente que dependa dela.
3. Arquivo presente em `Aprendizados/**` é memória, não consumidor operacional.
4. Remoção de COMPATIBILITY exige issue própria, busca estática fora de `Aprendizados/**`, testes e CI.
5. Documentação histórica pode continuar citando versões retiradas; isso não as reativa.

## 11. Candidatos para BN-04

A varredura independente encontrou estes candidatos sem consumidor vivo confirmado:
- `shared/gradebook-contracts/imports/import-persistence-transport-v7.ts`;
- `shared/gradebook-contracts/current-academic-year-v1.ts`;
- `shared/gradebook-contracts/imports/import-known-content-transport-v1.ts`;
- `server/gradebook/persistence/d1/runtime/d1-benchmark-instrumentation-v1.ts`.

**Este documento não os remove.** BN-04 faz a prova final e executa a retirada/movimentação, se segura.

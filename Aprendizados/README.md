# Aprendizados

Esta pasta preserva conhecimento técnico adquirido durante a construção do Ecossistema Escolar. Ela existe para que decisões, soluções e limitações que deram trabalho possam ser reutilizadas mesmo quando a tecnologia principal mudar.

## Importadores legados do Banco de Notas

- [`IMPORTADORES-LEGADOS/README.md`](IMPORTADORES-LEGADOS/README.md) — índice dos caminhos de importação retirados do runtime e preservados para estudo/reuso.
- [`IMPORTADORES-LEGADOS/D1-V8/`](IMPORTADORES-LEGADOS/D1-V8/) — código e testes do importador D1 V2–V8, incluindo compactação, staging, bootstrap e promoção atômica.
- [`IMPORTADORES-LEGADOS/HYPERDRIVE-SHADOW/`](IMPORTADORES-LEGADOS/HYPERDRIVE-SHADOW/) — código e testes da transição anterior PostgreSQL/Hyperdrive por probe, benchmark, backfill e shadow.

## D1 — Banco de Notas

- [`D1-BANCO-DE-NOTAS.md`](D1-BANCO-DE-NOTAS.md) — arquitetura, schema, versionamento, CAS, durabilidade e operação.
- [`D1-IMPORTACAO-V8.md`](D1-IMPORTACAO-V8.md) — evolução do importador até o transporte V8 por valores, staging e atomicidade.
- [`D1-DESEMPENHO-E-DIAGNOSTICO.md`](D1-DESEMPENHO-E-DIAGNOSTICO.md) — limites observados, metodologia de diagnóstico, medições e critérios para reutilizar D1.

## Regra de segurança

Este diretório é público. Ele registra arquitetura, contratos, métricas agregadas e técnicas. Não devem ser adicionados nomes, notas, arquivos, payloads ou qualquer dado real de estudante.

## Contexto

Cloudflare D1 foi escolhido originalmente como armazenamento físico principal do Banco de Notas pela BN-DEC-016 / issue #200. A implementação produziu uma base importante de conhecimento sobre persistência versionada, reimportação idempotente, snapshots, CAS, transações e recuperação.

Em setembro de 2026, benchmarks controlados mostraram que o caminho PostgreSQL via Hyperdrive é mais adequado à carga de importação atual. Isso não invalida o trabalho feito no D1: os padrões de domínio, contratos, versionamento, auditoria e vários mecanismos operacionais continuam reutilizáveis em qualquer backend.

Os importadores anteriores foram retirados do runtime após o cutover do modelo relacional e preservados integralmente em `IMPORTADORES-LEGADOS/`, para que o código ativo mantenha somente o caminho atual sem perder o aprendizado acumulado.

## Código arquivado (retirado da árvore em 08/11/2026)

O código e os testes dos importadores legados e do runtime D1 saíram da árvore atual: não rodam, não são compilados e só eram lidos por testes de texto. Os documentos desta pasta continuam. Para consultar o código, use o histórico do Git a partir do commit `558e6bbbbe8e`, por exemplo:

```bash
git show 558e6bbbbe8e:Aprendizados/RUNTIME-D1-RETIRADO-1079/server/gradebook/persistence/d1/runtime/d1-runtime-v1.ts
```

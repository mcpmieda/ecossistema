# Validação da revisão e do plano

Data: 11/10/2026. Base: `17e82f62b35b3ed2cc998b694adfc6b7f3b249fb`.
Validação local em Node `v24.16.0`, usando somente módulos nativos crypto/assert/fs e metadados/SQLs canônicos públicos. Nenhum segredo, corpo de rotação ou linha de aluno foi levado ao ensaio.

## Checagens executadas e resultados

| Checagem | Resultado |
|---|---|
| Inventário | 54 entradas e 54 versões únicas; pares version/name iguais aos remotos |
| Fontes | 43 caminhos candidatos e 11 sem arquivo exato |
| Espelho | 20261001224416 ausente |
| SHA-256 | Node crypto confirma independentemente todos os 43 digests brutos/trim calculados |
| Comparação | 19 brutos iguais; 10 iguais só após trim ASCII das bordas; 12 diferentes; 2 statements NULL |
| Trim | Confirmado que trim dos candidatos só retirou espaço/tab/CR/LF; conteúdo interno não normalizado |
| Rotações | Cinco registros; hashes/tamanhos/corpos não coletados |
| Histórico | Seis revisões dos três caminhos com duas revisões comparadas; nenhuma igualdade bruta/trim adicional |
| Representação | Três versões B explicadas por retirada de comentários iniciais e/ou BEGIN/COMMIT externos; níveis conservadores preservados |

Os dados sanitizados completos são [review-evidence.json](review-evidence.json). O mapa inclui os hashes por versão. Nenhum arquivo com corpo SQL faz parte da publicação.

## Ensaio dos gates de seleção — modelo isolado em memória

O modelo local parte apenas dos 54 pares documentais e de um artefato fictício, sem conectar ao banco. Foram exercitados:
1. Seleção de um artefato novo com digest correto: aceita.
2. Seleção de versão histórica: bloqueada antes de execução.
3. Alteração de bytes depois de fixar digest: bloqueada.
4. Drift no inventário observado: bloqueado.
5. Invariância dos 54 pares originais em todos os casos: confirmada.

Esse modelo testa regras do plano e a integridade dos metadados. Não é uma implementação de runner, não executa SQL e não prova a atomicidade ou o contrato de uma ferramenta Supabase.

## Ensaio PostgreSQL nativo local — bloqueado

Binários PostgreSQL `18.6` já estavam disponíveis. Foi inicializado um cluster descartável local e iniciado apenas em `127.0.0.1`.
O primeiro psql foi bloqueado com **Permission denied 10013**, antes de executar qualquer SQL. Não houve escalada, troca de transporte, alteração de ACL ou contorno.
A tentativa de parada informou que o PID já não existia; a conferência de processo não encontrou o servidor iniciado.
Produção retornou `17.6` em consulta somente leitura. Mesmo sem bloqueio, PostgreSQL 18.6 não substituiria uma verificação de compatibilidade 17.6.

Portanto: **nenhum ensaio de DDL, RLS/ACL, falha transacional ou schema Supabase foi concluído localmente**. O plano exige isso para a próxima migration concreta e exige testar o mecanismo real; não está liberado para produção por este documento.

## Cobertura nativa existente — evidência distinta

No head documental anterior da PR, `8f352aee38f36210d112cd89cbc8cc1bc12d3c29`, os checks observados chegaram a estados terminais:

| Check | Conclusão | Evidência |
|---|---|---|
| Bounded private Hyperdrive proof | skipped | [execução](https://github.com/mcpmieda/ecossistema-escola/actions/runs/38107804156/job/114377276728) |
| Lint, types, tests and build | success | [execução](https://github.com/mcpmieda/ecossistema-escola/actions/runs/38107804305/job/114377154300) |
| SonarCloud Code Analysis | success | [execução](https://github.com/mcpmieda/ecossistema-escola/runs/114376981386) |
| photo-codec / Source-built WebP in local Workerd | success | [execução](https://github.com/mcpmieda/ecossistema-escola/actions/runs/38107804305/job/114376930900) |
| Gradebook native PostgreSQL and contention | success | [execução](https://github.com/mcpmieda/ecossistema-escola/actions/runs/38107804156/job/114376924932) |
| Portal native PostgreSQL and role isolation | success | [execução](https://github.com/mcpmieda/ecossistema-escola/actions/runs/38107804156/job/114376924895) |
| Detect effective pull request changes | success | [execução](https://github.com/mcpmieda/ecossistema-escola/actions/runs/38107804305/job/114376908569) |
| Detect effective pull request changes | success | [execução](https://github.com/mcpmieda/ecossistema-escola/actions/runs/38107804156/job/114376908296) |
| Supabase Preview | skipped | [execução](https://github.com/mcpmieda/ecossistema-escola/runs/114376907498) |

Os gates nativos existentes validaram seu próprio escopo de código/schema. Esses sucessos não demonstram as regras do mecanismo futuro selecionado e não foram contados como ensaio de uma migration nova. Skips não representam reconciliação de ledger ou teste de produção.
Os comentários recentes da PR foram lidos antes da atualização: CodeRabbit pulou revisão de draft; SonarCloud informou gate aprovado. Nenhum comentário de bot foi tratado como autorização.

## Critérios para fechar esta etapa e limites remanescentes

A documentação pode ser revisada com todos os 54 eventos classificados, os níveis corrigidos, as 11 fontes exatas ausentes e as outras incertezas de conteúdo visíveis.
A sequência de aplicação automática completa permanece não demonstrada. Não há SQL novo ou correção histórica pendente aprovada nesta PR.
Antes de aplicar uma mudança futura, validar o artefato concreto em PostgreSQL compatível pela infraestrutura nativa autorizada existente e demonstrar preflight, aplicação única, rollback/falha, pós-condições e consistência do ledger pelo mecanismo real.
Banco/ledger/configurações/credenciais/permissões/deploy/integração não foram alterados; não houve merge.

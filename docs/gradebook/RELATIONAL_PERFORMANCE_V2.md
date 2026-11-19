# Desempenho relacional V2 — entrega #642 / PR #643

## Escopo e autoridade

Primeira matriz utilizável da FINAL-1/2, não conclusão de #633/#634. Base publicada antes desta entrega: main `cb6e3bf2309d4aa5716b600a3957046f133f850c`, deploy 256. O checkpoint de integração/publicação desta entrega fica na #642/#643, com SHA e execução efetivos; não inferir deploy a partir da presença deste arquivo.

Fonte funcional: `PAINEL DESEMPENHO` de 29/08/2026, especialmente contexto/matriz (§§2–6), detalhes (§§13–14), arquitetura/segurança (§§15–19) e validação por contrato (§22). O documento antigo do Banco permanece fonte somente para Conselho. O V2 explicita `authority: calculated-preview`: consulta calculada em validação, sem emissão de resultado oficial, mudança da autoridade global ou reinterpretação de históricos. Aceite acadêmico continua #347.

## Jornada e responsabilidades

Banco → Centrais ou Desempenho → contexto fixo 2026 → turma → período T1/T2/T3/Visão geral → modo Regular/Recuperação → matriz → comparação trimestral opcional V4 → detalhe do aluno/componente → cadastro nas Centrais.

`GradebookYearProvider` mantém 2026 e o epoch de autorização em memória no shell. Não há preferência de aba, seletor ou catálogo de escolha. Entrar na Importação não dispara consultas acadêmicas; a própria importação canônica recusa outro ano. Contratos V1 continuam exigindo mapeamento exato de `2026` para seu ID opaco. Identificador do aluno para navegação permanece em memória, não na URL. Um contador separado garante que abrir novamente o mesmo aluno atualize sua Central sem consultar novamente a matriz.

A tabela começa por Nº | Situação | Aluno | componentes. Filtro múltiplo usa opções do servidor. Situação é `gradebook.vinculo.situacao`, cuja autoridade é a Relação; a fonte docente só lança notas e não transporta esse campo. Os códigos são apresentados em chips cromáticos, sem virar resultado acadêmico. Vínculo histórico `FOI_PARA` não entra como posição atual; situações terminais podem exibir fatos, sem entrar nos indicadores dos vínculos sem situação especial/`ESTAVA_NO`. Selecionar uma situação não cria elegibilidade acadêmica.

A grade de notas das lentes (`PerformanceGridV2`) é uma tabela HTML nativa com papel `grid`. Ela usa as classes do HeroUI e o teclado da Table do React Aria, reproduzido em `src/shared/ui/grid-navigation-v1.ts`: uma parada de Tab, setas entre linhas, células e cabeçalho, Home/End, Ctrl+Home/End e Page Up/Down. A troca foi decidida na #1539. A Table do React Aria rodava ganchos próprios em cada uma das cerca de 500 células, e a troca de trimestre e o hover ficavam mais lentos (medição na #1539). Os papéis, os nomes acessíveis e a aparência foram conferidos contra a versão anterior. As demais tabelas continuam na Table do HeroUI.

Recuperação filtra somente alunos elegíveis pelos fatos resolvidos pelo motor naquele período. Elegibilidade ainda desconhecida tem contagem explícita e não vira aprovação/exclusão presumida. Indicadores clicáveis investigam dados incompletos ou resultados completos abaixo do limite; limpar investigação repõe o recorte.

Detalhe do aluno traz T1/T2/T3 separadamente, Conselho anterior desconhecido/Sim/Não e eventual decisão humana distinta do cálculo. Detalhe de componente carrega avaliações/atividades, máximos, quantitativo, qualitativo e paralela; o drawer preserva a ordem contratual e abre ancorado no trimestre selecionado pela matriz. Não existe inferência comportamental nem conversão em conceito qualitativo.

## Contrato e composição

`shared/gradebook-contracts/performance/relational-performance-v2.ts`: operações `classes`, `matrix`, `student-detail`, `cell-detail`. Zod valida entrada/saída, campos extras, limites, ano/identidade/período/modo, duplicatas e correspondência entre colunas/células. O mesmo POST `/api/gradebook/performance` faz dispatch explícito por `transportVersion: 2`; V1 permanece compatibilidade separada, sem fallback no caminho novo.

Handler preserva autenticação, capability administrativa, verificação de origem, limite de corpo, gate de produção e `no-store`. V2 usa diretamente `createRelationalPerformanceV2` sobre o facade PostgreSQL; não consulta streams/versions nem grava dados. Falha SQL não vira matriz vazia e erros internos não são expostos.

`projectPerformanceFactsV2` chama o motor simplificado existente. Fato zero, ausência, parcial, definição indisponível, REC pendente, não aplicável e N/C permanecem distintos. AM/U são referências de comparação, não substitutos do cálculo. Estados parciais vêm da cobertura do núcleo; a interface não determina a regra pelo número aparente de notas. Nenhuma fórmula ou enumeração de resultado acadêmico foi criada na interface.

A classificação visual é proporcional ao limite anual configurado e classifica todo total numérico, completo ou parcial; o parcial mantém `state=partial` e é marcado com `*`, e ausência continua sem classificação. Isso não muda a regra central de elegibilidade de REC. Decisão humana e resultado calculado são campos distintos. Ofertas duplicadas por componente são rejeitadas como ambíguas, não fundidas por nome.

O dashboard V5 acrescenta um ranking descritivo produzido no servidor: no máximo dez estudantes elegíveis, com valor numérico em todos os componentes, ordenados pelo somatório decrescente e com desempate estável por número/ID. O campo `partial` preserva a incompletude de qualquer componente. O ranking não é calculado na interface, não decide aprovação e não persiste resultado.

Com `includePrevious: true` (2º ou 3º trimestre, sem comparação e fora da lente de avaliações), a mesma resposta traz em `previous` o painel do trimestre anterior, montado das mesmas projeções na mesma transação, para as setas de variação. Antes eram dois pedidos que liam os mesmos fatos da turma (#1471, achado 100 da #1450).

## Consulta, tamanho e frescor

Cada resposta usa uma conexão/transação `REPEATABLE READ, READ ONLY`. Catálogo: três instruções; matriz e detalhes: até seis, incluindo SET e excluindo BEGIN/COMMIT. Uma consulta de fatos por recorte, não uma por aluno/componente. Descrição de instrumentos só é lida no detalhe de componente. A consulta de fatos abrange os três períodos da turma para resolver elegibilidade/resultado pelo núcleo; a resposta da matriz contém apenas os valores do período selecionado, não todas as avaliações do ano.

Limites atuais: 150 alunos, 40 ofertas e 1.000 pares aluno/oferta por matriz completa. Excesso é erro explícito antes da leitura de fatos, não truncamento. Catálogo de turmas pagina até 100 itens, com `nextOffset`. Matrizes maiores precisam de novo contrato de paginação, não de limite removido silenciosamente.

`readAt` é a hora da transação de leitura, não uma versão de importação nem garantia de tempo real. Atualização por nova consulta. O detalhe pode refletir importação posterior à matriz e informa seu horário; não existe snapshot permanente compartilhado entre requisições. Browser usa memória transitória, cancela/descarta respostas obsoletas e limpa os consumidores V2 ao perder autorização. Proteção de todas as áreas legadas ainda depende de seus próprios fluxos.

## Evidências e limitações

Testes presentes: 29 SQL/HTTP/semântica, 15 cliente/React com o shell real, três para booleano de Conselho pelo facade PostgreSQL e cinco para limites. A retomada de 10/09 executou localmente esses 52 testes com sucesso. A regressão de reabertura do mesmo aluno foi primeiro reproduzida com falha e depois aprovada com a correção; o teste também confirma uma única consulta de matriz durante essa navegação. O ensaio de 1.000 pares usa 100 alunos × 10 componentes sintéticos em T1/T2/T3/Visão geral: seis instruções, todas as linhas/colunas preservadas e payload abaixo de 500 KB gzip. 1.010 pares são recusados antes da consulta de fatos. Não é medição p95 de rede/Hyperdrive nem SLA de tela.

A validação completa para integração é a CI normal do head final, registrada na PR. O workflow temporário de exportação foi restaurado ao original. Um verify local completo foi interrompido pelo tempo máximo durante typecheck; não foi contabilizado como aprovado. Os testes focados foram executados separadamente.

Browser plugin não disponível nesta sessão; tentativa via Playwright/Chromium no servidor Vite `127.0.0.1:4173` foi bloqueada com `ERR_BLOCKED_BY_ADMINISTRATOR`, antes da renderização. Não houve inspeção visual atual nem evidência nova de desktop/mobile. Não contornar a política; registrar o gate visual e o smoke autenticado em #642/#406. Os testes React/jsdom não substituem essa inspeção. Imagens de retomadas anteriores não são evidência do head final.

## Requisitos que permanecem na #634

Quatro lentes e gráficos foram entregues na #645. A #649 acrescenta comparação explicitamente contratada entre trimestres de 2026, sem tendência, tolerância ou melhora/queda pedagógica; ver [V4](TERM_COMPARISON_2026_V4.md). Personalização visual, abertura padrão, inspeção responsiva/teclado conjunta e medições representativas continuam próprias. Coluna é Resultado calculado em validação, não Resultado final oficial. Boletins, Relatórios e Conselho foram reancorados; a configuração docente e a ordem institucional foram concluídas pela #660. Recuperação de dados e aceite institucional não são concluídos por este bloco.

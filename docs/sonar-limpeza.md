# Limpeza do SonarCloud (pedido do dono, 23/10/2026: "quero 0")

Arquivo de retomada. Quem continuar (outra conta do Claude, outra sessão) lê isto primeiro, confere
as PRs abertas com `gh pr list --search "sonar"` e segue da primeira etapa não concluída.

## Regras de trabalho

- Uma etapa por ramo `chore/sonar-<etapa>`, sempre saindo do `main` atual. Commit e push a cada
  arquivo ou grupo pequeno, para nada se perder se o limite acabar no meio.
- **Um merge por vez.** Antes do próximo, atualizar o ramo com `origin/main` e esperar o CI verde: o
  deploy recusa uma árvore que o CI não testou.
- Nenhuma mudança de comportamento. Refatorar só com os testes da área passando antes e depois
  (`npx vitest run <pasta>`), mais `npm run -s typecheck`, `npx eslint <arquivos> --max-warnings=0`
  e `npx prettier --check` nos arquivos que já estavam formatados no `main`.
- Migrations já aplicadas nunca mudam (são história conferida por hash).
- Lista atual dos apontamentos: `curl -s "https://sonarcloud.io/api/issues/search?componentKeys=mcpmieda_ecossistema-escola&resolved=false&ps=500&rules=<regra>"`.

## Situação em 23/10/2026 (depois da #1323)

1.749 abertos: 0 bugs, 1 vulnerabilidade, 1.748 de estilo.

## Etapas (marcar ao concluir, com o número da PR)

1. [x] Vulnerabilidade `githubactions:S6505`: `npm ci --ignore-scripts` em
   `validate-pull-request.yml` (lacre atualizado no teste FINAL-1). A falha anterior da prova do
   codec (`student-photo-codec-provenance-mismatch`) era o `main` andando durante o CI, não isso.
2. [x] `plsql:S1192` (92) e `plsql:S1138` (2): só em migrations aplicadas (imutáveis) → ignorar
   essas regras em `migrations/**` no `.sonarcloud.properties`.
3. [~] (parte automática na #1326) Regras mecânicas pequenas (≤ 46 cada): S3863 imports repetidos, S6582 optional chain, S7758
   codePointAt, S7781 replaceAll, S6353 `\d`, S4043 toSorted, S3735 void, S7749 separador numérico,
   S2681, S7778, S7763, S7755, S7765, S7786, S7773, S7780, S7747, S6557, S6749, S7750, S7766,
   S4782, S6594, S6564, S4323, S7718 e as demais de 1–6 ocorrências.
4. [x] `typescript:S6759` (152): props de componentes como `Readonly<…>`.
5. [~] (S4666 feito) CSS: `css:S4666` (143) seletores duplicados (juntar blocos), `css:S9423` (24) `!important`,
   `css:S9440` (10) reduced-motion, `css:S7924` (10) contraste.
6. [x] `typescript:S7503` (46) async sem await; `typescript:S6551` (33) stringificação de objeto.
7. [x] `typescript:S6819` (82) papéis ARIA → elementos nativos, com `scripts/sonar/native-roles.mjs`: `<p|span role="status">` mantêm a tag e o conteúdo vai para `<output className="contents">`; `<div role="status">` vira `<output className="block">`; `group` → `<fieldset className="min-w-auto">`, `region` → `<section>`, `list/listitem` → `<ul>/<li>`.
8. [x] `typescript:S9382` + `javascript:S9382` (170) await em laço: paralelizar só onde a ordem não
   importa; onde a ordem importa (transações, lotes sequenciais) justificar com `// NOSONAR` e motivo.
9. [ ] `typescript:S4624` (24) templates aninhados; `typescript:S8786` (11) regex com backtracking;
   `typescript:S6478` (12) componentes definidos dentro de componentes; S107 muitos parâmetros.
10. [x] `typescript:S3358` (425) ternários aninhados → `if`/funções auxiliares/mapas: #1331 (automática) e #1332 (manual).
11. [ ] `typescript:S3776` + `javascript:S3776` (192) complexidade cognitiva → extrair funções.
    Maior risco: fazer arquivo por arquivo, com os testes da área.

## Registro

- 23/10/2026: #1323 zerou os bugs (ordenações, comparações exatas marcadas, exclusões de migrations).
- 23/10/2026: #1325 vulnerabilidade do CI e regras Oracle (etapas 1 e 2).
- 23/10/2026: etapa 3, parte automática (ramo `chore/sonar-mecanicas`): ESLint com `unicorn`,
  `import-x` e `regexp` instalados FORA do repositório (pasta temporária, `npm i eslint@9
  eslint-plugin-unicorn@60 eslint-plugin-import-x@4 eslint-plugin-regexp@2 @typescript-eslint/parser@8
  @typescript-eslint/eslint-plugin@8`) e `--fix` só nos arquivos apontados. Cuidados aprendidos:
  NÃO usar `unicorn/prefer-math-min-max` (trocou comparação de textos por `Math.max`), nem
  `findLast` em TypeScript (a lib do projeto é ES2022), nem `.includes` em guardas de tipo
  (`x is T`); um teste confere o texto `bucket === 'below'` em `performance-dashboard-v5.ts`.
  Ficaram para mão: ~33 optional chain, S7758 codePointAt, S4043, S3735 void, S2681 e as raras.
- 23/10/2026: #1326 etapa 3 automática; etapa 4 (`Readonly` nas props) com script de AST do TypeScript.
- 24/10/2026: #1327 etapa 4. Etapa 5, S4666: seletores repetidos juntados com `cssmerge3.py` (junta na 1ª ocorrência, ou na última quando uma regra no meio, inclusive em `@media`, mudaria o resultado; também dentro de cada `@media`). Conferido no navegador: estilos calculados idênticos nas 6 abas do Desempenho e nas 6 do Painel do Aluno. Faltam S9423, S9440, S7924, S7925.
- 24/10/2026: etapas 6 e 8 (ramo `chore/sonar-async`): S6551 com `shared/scalar-text-v1.ts` (igual a `String()` exceto objeto puro, com teste); S7503 e S9382 revisados e marcados como não aplicáveis no `.sonarcloud.properties`, com o motivo (portas assíncronas; sequência proposital). Ferramentas guardadas em `scripts/sonar/` (`css-merge-duplicates.py`, `readonly-props.mjs`). ATENÇÃO: a 1ª versão do juntador de CSS quebrava comentários com `;` e o build falhou (#1328); corrigido e validado com lightningcss.
- 24/10/2026 (madrugada): S2681 (9) reescritos em linhas separadas; S7758: conversões de bytes trocadas por `codePointAt`/`fromCodePoint` (mesmo resultado de 0 a 255) e hashes de texto mantidos com NOSONAR (trocar mudaria hashes guardados). EM TESTE quando salvo.
- #1328 FECHADA sem merge. O CSS (etapa 5, S4666) precisa ser REFEITO numa PR nova a partir do main com a ferramenta corrigida (`scripts/sonar/css-merge-duplicates.py` + ordem pela última declaração + remoção de longas mortas, versão em `cssmerge3.py` desta sessão) e validada com lightningcss e no navegador; o Sonar apontou 3 S4657 na versão atual.
- 24/10/2026: etapa 5 (S4666) refeita no ramo `chore/sonar-css-v2`. A ferramenta tinha 3 premissas erradas, corrigidas: (1) comentário com `;` quebrava declarações; (2) a ordem final deve ser a da ÚLTIMA declaração de cada propriedade (curta × longa) e longas mortas saem (S4657); (3) classes diferentes NÃO provam elementos diferentes (`.pa-score-card` e `.pa-score-card--positive` estão no mesmo cartão): agora qualquer regra no meio com a mesma especificidade conta, salvo tag, `nth-child` ou valor de atributo diferentes. Resultado: 58 grupos juntados com segurança; **57 grupos ficaram de lado (PULADO)** para revisão manual, um a um, com comparação no navegador.
- Conferência no navegador (estilos calculados de todos os elementos, CSS original × novo, na mesma página): Desempenho 6 abas, Painel do Aluno 6 abas + detalhe do aluno, login 23 telas, boletim do portal 5 abas. Tudo idêntico, exceto ruídos conhecidos que já aparecem sem mudança (indicador das abas, margem que alterna com a barra de rolagem, contagem regressiva das telas 9/12 do login).
- Achado fora do Sonar (já existia antes desta noite, conferido no código do redesenho): no Desempenho, ao recarregar a página com uma turma já escolhida, a turma volta selecionada mas os dados não são pedidos (fica "carregando" até clicar em outra turma). Avisar o dono.
- 24/10/2026: #1330 (CSS S4666, versão segura) com merge. Etapa 10: `scripts/sonar/ternary-to-if.mjs` (AST do TypeScript) reescreve ternários aninhados em `return`, corpo de arrow e `const`. Cuidados: `return` que é o corpo de um `if` sem chaves ganha chaves (a 1ª versão mudava o comportamento em `server/platform/snapshot.ts`); `const` sem tipo ganha a união dos literais (senão `let` alarga 'a' para string). Lista dos trechos que sobram: varredura de AST por ternário dentro de ternário fora dessas posições.
- 24/10/2026: etapa 10 concluída. Regra exata do Sonar para S3358, conferida contra os 425 do main: conta um ternário cujo ternário de fora é alcançado SEM passar por função, elemento JSX, objeto ou lista (`scan2` com essas paradas dá exatamente 425). Ternário dentro de JSX dentro de outro ternário NÃO conta. Onde o mesmo componente aparecia em mais de um ramo, o resultado vai para uma variável antes do `return` (o React reaproveita a mesma peça). Ao inserir funções novas, nunca entre um comentário `/** */` e a função dele (aconteceu duas vezes; corrigido).
- **ACHADO 24/10/2026: `sonar.issue.ignore.multicriteria` NÃO vale na análise automática.** O `.sonarcloud.properties` só aceita `sonar.sources`, `sonar.exclusions`, `sonar.inclusions`, `sonar.tests`, `sonar.test.exclusions`, `sonar.test.inclusions`, `sonar.sourceEncoding` e `sonar.cpd.exclusions` (docs SonarQube Cloud, Automatic analysis). Por isso `plsql:S1192` (92), `typescript/javascript:S9382` (170) e `typescript:S7503` (46) continuam abertos. Caminhos: (a) o dono cadastra as mesmas regras na tela do SonarCloud (Administration > General Settings > Analysis Scope > Ignore Issues on Multiple Criteria); (b) `// NOSONAR` com motivo em cada linha; (c) marcar como "Accepted" na tela. Feito em 24/10/2026: as 5 regras (plsql:S1192 e S1138 em `**/*.sql`; typescript:S7503, typescript:S9382 e javascript:S9382 em `**/*`) cadastradas na tela do SonarCloud a pedido do dono; valem a partir da próxima análise do main. O bloco no `.sonarcloud.properties` fica como registro do motivo.
- Achado fora do Sonar (mantido como estava, avisar o dono): nos Boletins do Banco de Notas, o selo "Não aprovado" fica verde, porque `'not-approved'.includes('approved')` é verdadeiro (`relational-bulletin-page-v2.tsx`, `classificationColor`).
- 24/10/2026: etapa 7. Primeira tentativa (trocar `<p>` por `<output>`) perdia estilos que miram a tag `p` (`.pa-auth-card p`, `p[role='status']`); a segunda (envolver em `<output>`) juntava os itens de um `<p>` flex. Versão final com `display: contents`. Conferido no navegador comparando posição, tamanho e cor de cada texto, antes × depois: ADM 6 abas, portal (Notas, Frequência, Horário) em celular e computador, login 23 telas com animações desligadas. Iguais, exceto relógios. Componentes (`Card`, `Alert`, `Surface`, `Table.ScrollContainer`) mantêm `role`: o Sonar não os aponta.

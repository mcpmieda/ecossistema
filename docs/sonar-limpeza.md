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
6. [ ] `typescript:S7503` (46) async sem await; `typescript:S6551` (33) stringificação de objeto.
7. [ ] `typescript:S6819` (82) role="group" → `<fieldset>`/elementos nativos (cuidado com estilo e
   testes que buscam `getByRole('group')`).
8. [ ] `typescript:S9382` + `javascript:S9382` (170) await em laço: paralelizar só onde a ordem não
   importa; onde a ordem importa (transações, lotes sequenciais) justificar com `// NOSONAR` e motivo.
9. [ ] `typescript:S4624` (24) templates aninhados; `typescript:S8786` (11) regex com backtracking;
   `typescript:S6478` (12) componentes definidos dentro de componentes; S107 muitos parâmetros.
10. [ ] `typescript:S3358` (424) ternários aninhados → `if`/funções auxiliares/mapas.
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

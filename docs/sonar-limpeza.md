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

1. [ ] Vulnerabilidade `githubactions:S6505`: `npm ci` sem `--ignore-scripts` em
   `validate-pull-request.yml`. Com `--ignore-scripts` a prova do codec de fotos falhou
   (`student-photo-codec-provenance-mismatch`): investigar o que o codec precisa dos scripts de
   instalação antes de mudar. O teste FINAL-1 tem um lacre (hash) desse arquivo.
2. [x] `plsql:S1192` (92) e `plsql:S1138` (2): só em migrations aplicadas (imutáveis) → ignorar
   essas regras em `migrations/**` no `.sonarcloud.properties`.
3. [ ] Regras mecânicas pequenas (≤ 46 cada): S3863 imports repetidos, S6582 optional chain, S7758
   codePointAt, S7781 replaceAll, S6353 `\d`, S4043 toSorted, S3735 void, S7749 separador numérico,
   S2681, S7778, S7763, S7755, S7765, S7786, S7773, S7780, S7747, S6557, S6749, S7750, S7766,
   S4782, S6594, S6564, S4323, S7718 e as demais de 1–6 ocorrências.
4. [ ] `typescript:S6759` (152): props de componentes como `Readonly<…>`.
5. [ ] CSS: `css:S4666` (143) seletores duplicados (juntar blocos), `css:S9423` (24) `!important`,
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

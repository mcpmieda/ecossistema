# Regras para agentes de IA

Este repositório deve permanecer simples, funcional e rastreável. A prioridade é alterar somente o necessário para o Centro de Administração e para o Banco de Notas, reutilizando a estrutura existente e evitando camadas permanentes sem utilidade comprovada.

## Revisão automática

CodeRabbit (`@coderabbitai review` quando a revisão acrescentar valor) e SonarQube Cloud (Quality Gate) revisam os PRs. Uma falha do Quality Gate deve ser resolvida antes do merge. Nenhum dos dois substitui o CI nem concede autoridade de merge, deploy, segurança, dados ou infraestrutura.

## Operador Cloudflare read-only

Existe um operador Cloudflare via GitHub Actions para diagnóstico sanitizado sem expor secrets: use `/cloudflare` para capacidades e `/cloudflare portal` para o diagnóstico do Portal. Consulte `docs/infra/CLOUDFLARE_OPERATOR.md` antes de ampliar esse fluxo; ele é somente leitura e reutiliza as credenciais já existentes.

## Regras gerais

- Faça a menor mudança suficiente para a issue atribuída.
- Trabalhe em uma branch curta, com uma issue e um pull request por entrega. Uma fase grande pode ter entregas sequenciais; PR parcial não fecha a fase automaticamente.
- Reutilize contratos, componentes e serviços existentes antes de criar novos.
- Não altere branch protection, rulesets, permissões, secrets, ambientes, aplicações Entra, recursos Cloudflare ou Microsoft 365 sem autorização explícita.
- App Factory, Factory Runs, merge trains e orquestradores permanentes continuam proibidos sem autorização explícita.
- Em cada issue `[BN]`, a documentação canônica é a autoridade.
- Integre e publique entregas concluídas do escopo aprovado sem pedir nova confirmação por PR: autorização contínua de 10/09/2026, #182 comentário `5618750384`, BN-DEC-023. Antes do merge, revise o diff e confirme `npm run verify`/CI no head final; use SHA esperado e o workflow oficial de deploy. Todo PR integrado à `main` deve usar **merge commit**; `squash` e `rebase` são incompatíveis com a proveniência produtiva que exige dois pais. Não contorne checks, conflitos ou bloqueadores e não habilite merge incondicional.
- Nunca inclua nomes, notas, arquivos ou outros dados reais de estudantes em código, fixtures, issues, commits, logs ou screenshots. O repositório é público.
- Política de segurança (CSP) nos quatro lugares — `workers/student-portal/edge/[[path]].ts`, `workers/student-portal/build-edge.mjs` (`ASSET_CSP_V1`, assets do Portal), `public/_headers` e `server/http/security.ts` — usa `style-src 'self'` mais a hash sha256 do único `<style>` que o React Aria injeta; nunca `unsafe-inline`. Estilos e scripts embutidos são bloqueados em produção (o preview local não aplica CSP): quando uma biblioteca injeta `<style>` (ex.: `input-otp`), copie as regras para o CSS do próprio módulo. Se atualizar o `react-aria` ou mexer em `style-src`, o teste `tests/frontend-security/react-aria-style-csp.test.ts` indica a hash nova.
- Antes de integrar, confirme que a `main` não avançou depois do CI do seu PR. Se outro PR entrou (inclusive de outra sessão trabalhando em paralelo), traga a `main` para a sua branch e espere o CI verde de novo: o deploy de produção recusa qualquer árvore que os gates do PR não testaram ("Validated tree does not match production tree") e nada é publicado. Integre um PR por vez.
- Nos apps do navegador (ADM e Portal), `canvas.toBlob`/`OffscreenCanvas.convertToBlob` em **PNG ou JPEG** entrega o resultado com ~1 s de atraso mesmo com a página ociosa (medido em 26/09/2026; WebP não é afetado). Em laços (lotes de cartões, páginas de PDF) isso vira dezenas de segundos: codifique com `canvas.toDataURL` síncrono, como em `src/features/student-portal-admin/credentials/canvas-encode-v1.ts`.
- Durante o trabalho bastam testes direcionados ao escopo; `npm run verify`/CI no head final é obrigatório antes de declarar a entrega pronta. Registre o SHA e o ambiente da execução; CI não é teste manual de produção.

## Entrega completa e validação real

Diretriz geral do responsável em **23/09/2026, 15:03 UTC**, registrada na #1128: **definir estratégia e escopo final → implementar o produto completo → integrar e disponibilizar a entrega pronta → validar o uso no ambiente real com o responsável**.

- Implemente todo o escopo aprovado, incluindo interfaces, serviços, integrações e configuração aplicável. Não entregue uma versão reduzida, demonstrativa ou exclusiva de piloto que depois precise ser refeita para o uso final. PRs internos podem organizar a execução, sem exigir teste manual ou nova aprovação funcional de cada fatia quando o escopo já estiver autorizado.
- Quando o escopo for toda a escola, a solução deve atender toda a escola. A escolha de começar o teste real com uma turma, poucos usuários ou horários controlados é operacional e pertence ao responsável. Não criar allowlist, flag de piloto, bloqueio por turma ou limite artificial de população sem pedido explícito. Isso não remove autenticação, autorização, elegibilidade ou políticas legítimas existentes, nem autoriza ativar contas, distribuir credenciais ou alterar dados em massa.
- Priorize o teste funcional do produto pronto no ambiente real. Evite construir ambientes, versões paralelas, massas ou baterias sintéticas extensas que dupliquem a implementação e o trabalho de validação. Não usar um laboratório sintético amplo como etapa obrigatória por padrão. Reutilize a infraestrutura e a cobertura existentes; acrescente apenas regressões técnicas pontuais necessárias ao risco da alteração.
- A preferência por validação real posterior não elimina lint, tipos, build, revisão de segurança, integridade de migrations ou gates de CI já exigidos. Concentre verificações técnicas na entrega integrada, sem repetir suítes completas a cada subtarefa e sem desativar testes para aprovar. Não publicar defeito crítico conhecido nem executar ensaio destrutivo/carga artificial sobre dados reais para evitar fixtures.
- Entregue o produto completo com roteiro curto e monitoramento existente suficiente. O responsável conduz o teste real e decide participantes, momento e ampliação. Não interromper o desenvolvimento à espera de testes de uso intermediários quando a entrega final ainda não estiver pronta.
- Registre separadamente **implementação concluída/publicada** e **validação real pendente/concluída**. A validação real posterior não transforma uma implementação completa em versão parcial; sua ausência também não comprova homologação, capacidade de carga ou resultado funcional. Limitações materiais de segurança, acesso ou infraestrutura devem ser informadas, sem criar bloqueadores artificiais de piloto.

## Textos nas interfaces — todo o Ecossistema

Orientação explícita do responsável em 18/09/2026, 00:10 UTC, registrada na #846; aplica-se ao Centro de Administração, Banco de Notas, Portal do Aluno e demais módulos, em correções e novas implantações.

- Não acrescente comentários explicativos, justificativas técnicas, notas sobre correções/implantações ou detalhes internos de cálculo às telas, salvo quando absolutamente necessários para compreender ou executar a tarefa com segurança. Não troque um comentário removido por outro texto, tooltip ou aviso não solicitado.
- Mantenha apenas textos úteis à operação: rótulos, resultados, estados e mensagens indispensáveis. Preserve acessibilidade, avisos essenciais de erro, conflito, indisponibilidade, segurança, perda de dados e confirmações de ações críticas; não faça remoção indiscriminada dessas mensagens.
- Registre razões técnicas, alterações de fórmula, evidências e histórico em issues, PRs e documentação, não como comentários permanentes na interface. Na revisão do diff, confira se cada novo texto visível é realmente necessário.

## Banco de Notas

A construção modular está autorizada e é coordenada por `docs/gradebook/` e pelas issues `[BN]`.

Antes de modificar o Banco, leia nesta ordem:

1. `AGENTS.md`;
2. `docs/gradebook/README.md`;
3. `docs/gradebook/PROJECT_STATE.yaml`;
4. `docs/gradebook/DECISIONS.md`, incluindo as decisões anteriores vinculadas e as substituições BN-DEC-022/023;
5. a issue atribuída;
6. `CONSUMER_MAP.md`, os contratos, o contrato da fonte e a matriz de testes relacionados.

Regras obrigatórias:

- HeroUI React v3 é o sistema visual transversal. Domínio e motor não importam React nem HeroUI.
- O Banco usa o mesmo shell, identidade, autorização, pesquisa e publicação do Centro.
- A Relação do ano é o cadastro mestre; planilhas dos professores são fonte de lançamentos. A reconstrução #613 e seus comentários finais governam o modelo relacional, não o antigo schema streams/versions.
- Não exigir planilha técnica padronizada. O importador reconhece os arquivos reais existentes.
- Importador externo V9 e serviços internos V10/V11 já estão homologados. Não os substituir pelo legado arquivado.
- PostgreSQL/Supabase via Hyperdrive `PROD_DB` é a persistência oficial. Um nome `d1-*` não prova uso físico do D1: verificar rota, composição e SQL antes de retirar código.
- Uma regra acadêmica existe em um único núcleo. Interface, Desempenho, Conselho, Boletins e Relatórios não criam cálculos concorrentes.
- Persistência homologada, motor implementado e autoridade acadêmica aceita são estados diferentes. A #347 registra o aceite por consumidor/escopo; não há ativação ou reinterpretação histórica silenciosa.
- Diagnósticos de importação guardam somente problemas atuais, conforme #629. Histórico acadêmico e decisões humanas permanecem separados e preservados.
- Mudanças em contratos compartilhados exigem issue `[BN][CONTRATO]` própria. Um agente não amplia contrato silenciosamente dentro de outra tarefa.
- Cada issue declara caminhos permitidos. Não altere arquivos fora deles sem registrar a necessidade e aguardar ajuste de escopo.
- Atualize `PROJECT_STATE.yaml` só ao concluir/publicar uma entrega, distinguindo baseline integrada, trabalho na branch e publicação verificada.
- Ao concluir, registre na issue: estado, commit, arquivos, contratos alterados, testes, pendências e próxima tarefa segura.
- Uma entrega independente só é concluída depois de integrada à `main`, publicada pelo workflow oficial e verificada no site quando houver resultado visível. Limitação de acesso para smoke autenticado/visual deve ser registrada; deploy não equivale a homologação funcional.

## Precedência de decisões

As decisões cronológicas indexadas em `docs/gradebook/DECISIONS.md` são a autoridade do projeto. A primeira decisão oficial permanece quando não existir substituição expressa. BN-DEC-022 consolida substituições aprovadas na #613/#629 e o programa final, sem apagar BN-DEC-001–021. BN-DEC-023 substitui somente a confirmação individual de integração/publicação por autorização contínua condicionada aos gates. `Aprendizados/` e `docs/gradebook/history/` são memória, não autorização operacional atual; decisões antigas continuam valendo apenas pelo índice de `DECISIONS.md`.

## Regra de decisão técnica

Quando houver duas soluções válidas, escolha a que preserve os contratos oficiais com menos duplicação, menos serviços, menos automação permanente e menor impacto no repositório. Não recrie tabelas antigas para fazer uma tela passar; registre e resolva a lacuna mínima de contrato/persistência.

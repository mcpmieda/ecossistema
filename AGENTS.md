# Regras para agentes de IA

Este repositório deve permanecer simples, funcional e rastreável. A prioridade é alterar somente o necessário para o Centro de Administração e para o Banco de Notas, reutilizando a estrutura existente e evitando camadas permanentes sem utilidade comprovada.

## Equipe de agentes homologada

![ChatGPT](https://img.shields.io/badge/ChatGPT-L%C3%ADder-10A37F?logo=openai&logoColor=white)
![Jules](https://img.shields.io/badge/Jules-Executor-4285F4?logo=google&logoColor=white)
![CodeRabbit](https://img.shields.io/badge/CodeRabbit-Revis%C3%A3o-F97316)
![SonarQube Cloud](https://img.shields.io/badge/SonarQube_Cloud-Gate-126ED3)

Equipe homologada em 19/09/2026. **ChatGPT** é o líder/coordenador padrão; os demais papéis não alteram por si só as regras de merge, deploy, segurança, dados ou infraestrutura.

| Agente/ferramenta | Papel | Acionamento padrão | Uso principal | Limite de autoridade |
| --- | --- | --- | --- | --- |
| **ChatGPT** | Líder e coordenador | coordenação pelo responsável via ChatGPT | arquitetura, contratos, regras, segurança, integração, delegação e decisão técnica final | decide dentro do escopo autorizado; merge/deploy somente quando as autorizações vigentes e todos os gates permitirem |
| **Jules** | Executor assíncrono amplo | integração Jules/GitHub | funcionalidades e correções delimitadas que se beneficiem de execução assíncrona mais ampla | entrega candidata; não recebe autoridade arquitetural, merge direto, deploy ou acesso adicional a secrets |
| **CodeRabbit** | Revisor independente | `@coderabbitai review` quando revisão acrescentar valor | regressões, segurança, inconsistências e segunda leitura de PRs | revisão/comentários; não é autoridade arquitetural nem substitui CI/gates |
| **SonarQube Cloud** | Gate automático de qualidade e segurança | Automatic Analysis via GitHub App | análise estática, security rating, hotspots e Quality Gate | não escreve código nem decide arquitetura; bloqueia integração quando o gate oficial falha |

### Operador Cloudflare read-only

Existe um operador Cloudflare via GitHub Actions para diagnóstico sanitizado sem expor secrets: use `/cloudflare` para capacidades e `/cloudflare portal` para o diagnóstico do Portal. Consulte `docs/infra/CLOUDFLARE_OPERATOR.md` antes de ampliar esse fluxo; ele é somente leitura e reutiliza as credenciais já existentes.

## Regras gerais

- Faça a menor mudança suficiente para a issue atribuída.
- Trabalhe em uma branch curta, com uma issue e um pull request por entrega. Uma fase grande pode ter entregas sequenciais; PR parcial não fecha a fase automaticamente.
- Reutilize contratos, componentes e serviços existentes antes de criar novos.
- Não altere branch protection, rulesets, permissões, secrets, ambientes, aplicações Entra, recursos Cloudflare ou Microsoft 365 sem autorização explícita.
- App Factory, Factory Runs, merge trains e orquestradores permanentes continuam proibidos sem autorização explícita. O agente líder, porém, possui autorização contínua de 18/09/2026 para invocar, distribuir, reatribuir, interromper e combinar trabalho entre agentes auxiliares já conectados/homologados quando isso reduzir o tempo total sem reduzir a qualidade.
- Cada issue `[BN]` mantém um agente responsável e a documentação canônica como autoridade. O responsável ou o agente líder pode delegar subtarefas bem delimitadas a outros agentes; a delegação não cria nova fonte de verdade nem transfere a autoridade arquitetural.
- Integre e publique entregas concluídas do escopo aprovado sem pedir nova confirmação por PR: autorização contínua de 10/09/2026, #182 comentário `5618750384`, BN-DEC-023. Antes do merge, revise o diff e confirme `npm run verify`/CI no head final; use SHA esperado e o workflow oficial de deploy. Todo PR integrado à `main` deve usar **merge commit**; `squash` e `rebase` são incompatíveis com a proveniência produtiva que exige dois pais. Não contorne checks, conflitos ou bloqueadores e não habilite merge incondicional.
- Nunca inclua nomes, notas, arquivos ou outros dados reais de estudantes em código, fixtures, issues, commits, logs ou screenshots. O repositório é público.
- Política de segurança (CSP) nos quatro lugares — `workers/student-portal/edge/[[path]].ts`, `workers/student-portal/build-edge.mjs` (`ASSET_CSP_V1`, assets do Portal), `public/_headers` e `server/http/security.ts` — usa `style-src 'self'` mais a hash sha256 do único `<style>` que o React Aria injeta; nunca `unsafe-inline`. Estilos e scripts embutidos são bloqueados em produção (o preview local não aplica CSP): quando uma biblioteca injeta `<style>` (ex.: `input-otp`), copie as regras para o CSS do próprio módulo. Se atualizar o `react-aria` ou mexer em `style-src`, o teste `tests/frontend-security/react-aria-style-csp.test.ts` indica a hash nova.
- Antes de integrar, confirme que a `main` não avançou depois do CI do seu PR. Se outro PR entrou (inclusive de outro agente trabalhando em paralelo), traga a `main` para a sua branch e espere o CI verde de novo: o deploy de produção recusa qualquer árvore que os gates do PR não testaram ("Validated tree does not match production tree") e nada é publicado. Integre um PR por vez.
- Nos apps do navegador (ADM e Portal), `canvas.toBlob`/`OffscreenCanvas.convertToBlob` em **PNG ou JPEG** entrega o resultado com ~1 s de atraso mesmo com a página ociosa (medido em 26/09/2026; WebP não é afetado). Em laços (lotes de cartões, páginas de PDF) isso vira dezenas de segundos: codifique com `canvas.toDataURL` síncrono, como em `src/features/student-portal-admin/credentials/canvas-encode-v1.ts`.
- O head final integrado deve passar `npm run verify`/CI antes de a entrega ser declarada pronta. Agentes executores não precisam repetir a suíte completa em cada subtarefa quando testes direcionados cobrem seu escopo; a verificação completa é concentrada no head final para evitar trabalho redundante. Registre o SHA e o ambiente da execução; CI não é teste manual de produção.

## Entrega completa e validação real

Diretriz geral do responsável em **23/09/2026, 15:03 UTC**, registrada na #1128: **definir estratégia e escopo final → implementar o produto completo → integrar e disponibilizar a entrega pronta → validar o uso no ambiente real com o responsável**.

- Implemente todo o escopo aprovado, incluindo interfaces, serviços, integrações e configuração aplicável. Não entregue uma versão reduzida, demonstrativa ou exclusiva de piloto que depois precise ser refeita para o uso final. PRs internos podem organizar a execução, sem exigir teste manual ou nova aprovação funcional de cada fatia quando o escopo já estiver autorizado.
- Quando o escopo for toda a escola, a solução deve atender toda a escola. A escolha de começar o teste real com uma turma, poucos usuários ou horários controlados é operacional e pertence ao responsável. Não criar allowlist, flag de piloto, bloqueio por turma ou limite artificial de população sem pedido explícito. Isso não remove autenticação, autorização, elegibilidade ou políticas legítimas existentes, nem autoriza ativar contas, distribuir credenciais ou alterar dados em massa.
- Priorize o teste funcional do produto pronto no ambiente real. Evite construir ambientes, versões paralelas, massas ou baterias sintéticas extensas que dupliquem a implementação e o trabalho de validação. Não usar um laboratório sintético amplo como etapa obrigatória por padrão. Reutilize a infraestrutura e a cobertura existentes; acrescente apenas regressões técnicas pontuais necessárias ao risco da alteração.
- A preferência por validação real posterior não elimina lint, tipos, build, revisão de segurança, integridade de migrations ou gates de CI já exigidos. Concentre verificações técnicas na entrega integrada, sem repetir suítes completas a cada subtarefa e sem desativar testes para aprovar. Não publicar defeito crítico conhecido nem executar ensaio destrutivo/carga artificial sobre dados reais para evitar fixtures.
- Entregue o produto completo com roteiro curto e monitoramento existente suficiente. O responsável conduz o teste real e decide participantes, momento e ampliação. Não interromper o desenvolvimento à espera de testes de uso intermediários quando a entrega final ainda não estiver pronta.
- Registre separadamente **implementação concluída/publicada** e **validação real pendente/concluída**. A validação real posterior não transforma uma implementação completa em versão parcial; sua ausência também não comprova homologação, capacidade de carga ou resultado funcional. Limitações materiais de segurança, acesso ou infraestrutura devem ser informadas, sem criar bloqueadores artificiais de piloto.

## Hierarquia de agentes e delegação

Objetivo: permitir o uso de vários agentes sem criar arquiteturas concorrentes, regras duplicadas ou diferenças de qualidade entre módulos.

- Toda tarefa com impacto relevante deve ter um **agente líder**. O agente líder é o agente de maior capacidade disponível e explicitamente designado para compreender o problema de ponta a ponta. Na configuração atual, quando a coordenação ocorre via ChatGPT, o papel de líder é exercido por **ChatGPT**, salvo decisão diferente do responsável. Essa designação é operacional e pode mudar no futuro sem alterar a política.
- Ficam reservadas ao agente líder a definição ou revisão de: arquitetura; regras de negócio e acadêmicas; contratos compartilhados; limites entre módulos; autenticação e autorização; modelo de dados, schema e migrations; segurança; comportamento transversal; CI/deploy; integrações externas; produção e qualquer decisão que possa criar um novo padrão para o Ecossistema.
- Jules e outros agentes auxiliares são, por padrão, **agentes executores ou revisores**, não autoridades arquiteturais. Podem implementar código, testes, documentação, refatorações mecânicas e correções localizadas quando o trabalho estiver suficientemente especificado. Só assumem papel de líder quando o responsável os designar expressamente para isso.
- A autorização contínua registrada em 18/09/2026 permite ao agente líder decidir autonomamente **se**, **quando**, **para quem** e **em paralelo com o quê** delegar trabalho a agentes já homologados, sem pedir nova confirmação por chamada. Nova instalação, nova credencial, ampliação de permissões de terceiros ou acesso a recursos sensíveis continua exigindo a autorização aplicável.
- Antes de delegar implementação, o agente líder deixa um handoff proporcional ao risco na issue, comentário ou descrição da tarefa. Correções locais podem receber um handoff curto; mudanças transversais, acadêmicas, de contrato, dados, segurança ou infraestrutura exigem handoff completo contendo: objetivo; paths/componentes; fonte de verdade; invariantes; proibições; testes/critérios de aceite; e evidências de conclusão.
- Um executor não deve reinterpretar requisitos vagos, criar arquitetura alternativa, ampliar contratos, mover responsabilidade entre módulos, alterar regras acadêmicas, enfraquecer testes, contornar gates ou “resolver por fora” uma limitação do handoff. Se descobrir que isso é necessário, deve parar nesse ponto e devolver a decisão ao líder.
- Trabalho delegado deve atingir o mesmo padrão de qualidade do restante do sistema: tipagem, testes, tratamento de erros, segurança, acessibilidade, nomenclatura, reutilização de contratos e consistência visual não podem ser reduzidos por o executor ser um agente secundário.
- Em trabalho paralelo, prefira escopos de arquivos e responsabilidades não sobrepostos. Dois agentes não devem implementar versões concorrentes da mesma regra de negócio ou do mesmo contrato. Quando houver sobreposição inevitável, o líder define previamente a fonte de verdade e faz a integração final.
- A saída de um executor é uma **entrega candidata**, não uma nova autoridade do projeto. A revisão é baseada em risco: mudanças críticas/transversais exigem revisão direta do agente líder sobre os trechos e invariantes relevantes; mudanças locais podem ser aceitas com escopo conferido, testes, CI e/ou revisão independente suficiente. O líder não precisa repetir linha a linha nem reexecutar evidências já confiáveis somente por redundância.
- Regras de negócio continuam com uma única fonte de verdade. Delegar interfaces, relatórios, Portal, Conselho, Desempenho ou outros consumidores nunca autoriza recriar cálculo, elegibilidade ou interpretação já pertencentes ao núcleo oficial.
- Nenhum papel de agente concede, por si só, autoridade adicional para merge, deploy, produção, secrets, permissões ou infraestrutura. Essas ações continuam regidas pelas autorizações e gates próprios do repositório.

### Estratégia operacional de velocidade

A meta é minimizar o **tempo até uma entrega correta**, não maximizar a quantidade de agentes usados.

- **Fast lane — correção simples/local:** use um único executor, de preferência o agente líder quando a alteração for imediata ou o agente já mais bem posicionado. Não convoque múltiplos agentes para produzir a mesma correção. Rode testes direcionados e deixe a suíte completa para o head final.
- **Delegação única — tarefa delimitada:** quando outro agente puder implementar enquanto o líder continua análise, integração ou outra tarefa, delegue a ele um pacote autocontido. O líder não fica esperando ocioso se houver trabalho independente disponível.
- **Paralelo — módulos independentes:** divida por responsabilidades e paths não sobrepostos. Cada frente tem um único escritor principal. Integrações entre as frentes são definidas antes pelo líder por contrato/interface/fonte de verdade.
- **Crítico/transversal:** o líder define arquitetura, regra acadêmica/negócio, contratos e limites. Implementação mecânica, consumidores, testes, documentação, migrações já especificadas e verificações podem ser distribuídos em paralelo. Use pelo menos uma verificação independente proporcional ao risco, não uma cadeia de revisores redundantes.
- **Long-running:** enquanto agente remoto, build, testes ou CI estiverem executando, avance outra frente independente. Só bloqueie o fluxo quando o resultado pendente estiver no caminho crítico da próxima decisão.
- **Falha/bloqueio:** se um executor sair do escopo, ficar preso ou exigir decisão arquitetural, interrompa ou redirecione cedo. Não gaste cota esperando iterações de baixo valor.
- **Implementação duplicada:** dois agentes só implementam a mesma solução quando o líder deseja comparação deliberada, quando a primeira abordagem falhou/bloqueou, ou quando a incerteza técnica justifica o custo. Não é o padrão.
- **Revisão distribuída:** quem escreve não precisa ser o único a conferir. Code review, testes, CI e ferramentas especializadas podem validar o trabalho em paralelo. O líder concentra atenção manual no que pode alterar contratos, regras, segurança, dados ou comportamento transversal.
- **Cotas e custo:** prefira o agente que resolve o trabalho com menor latência/custo e preserve agentes/cotas escassos para tarefas em que tragam vantagem real.
- **Fan-out:** por padrão, use no máximo dois executores de código simultâneos dentro da mesma entrega. Amplie somente quando houver três ou mais pacotes realmente independentes; paralelismo que aumenta conflito ou integração é contraproducente.
- **Merge/deploy:** rapidez não remove os gates oficiais. Um executor pode produzir branch/PR e corrigir sua própria entrega, mas integração em `main`, produção, secrets, permissões e governança continuam sob as autoridades definidas neste repositório.

### Modelo mínimo de handoff para outro agente

Use uma especificação equivalente a esta antes de entregar trabalho de implementação:

- **Líder:** agente responsável pela decisão técnica e integração.
- **Executor:** Jules ou outro agente autorizado.
- **Objetivo:** resultado concreto a produzir.
- **Escopo permitido:** arquivos, módulos e operações autorizadas.
- **Fonte de verdade:** issue, decisão, contrato ou implementação canônica aplicável.
- **Preservar:** invariantes, APIs, regras, UX e compatibilidade obrigatórias.
- **Não fazer:** alterações fora do escopo, decisões arquiteturais e atalhos proibidos.
- **Validar:** testes e comandos que devem passar.
- **Entregar:** resumo, diff, testes executados, limitações encontradas e qualquer decisão devolvida ao líder.

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
- Agentes de implementação não editam `PROJECT_STATE.yaml`, salvo quando a issue os nomear como integrador. Distinguir baseline integrada de trabalho na branch e de publicação verificada.
- Ao concluir, registre na issue: estado, commit, arquivos, contratos alterados, testes, pendências e próxima tarefa segura.
- Uma entrega independente só é concluída depois de integrada à `main`, publicada pelo workflow oficial e verificada no site quando houver resultado visível. Limitação de acesso para smoke autenticado/visual deve ser registrada; deploy não equivale a homologação funcional.

## Precedência de decisões

As decisões cronológicas indexadas em `docs/gradebook/DECISIONS.md` são a autoridade do projeto. A primeira decisão oficial permanece quando não existir substituição expressa. BN-DEC-022 consolida substituições aprovadas na #613/#629 e o programa final, sem apagar BN-DEC-001–021. BN-DEC-023 substitui somente a confirmação individual de integração/publicação por autorização contínua condicionada aos gates. `history/` e `Aprendizados/` são memória, não autorização operacional atual.

## Regra de decisão técnica

Quando houver duas soluções válidas, escolha a que preserve os contratos oficiais com menos duplicação, menos serviços, menos automação permanente e menor impacto no repositório. Não recrie tabelas antigas para fazer uma tela passar; registre e resolva a lacuna mínima de contrato/persistência.

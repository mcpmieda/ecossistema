# Decisões oficiais do Banco de Notas

Este é o índice cronológico normativo. A primeira decisão oficial prevalece, salvo substituição expressa. Arquivamento documental não revoga regra por si só.

## BN-DEC-001–021 — texto integral preservado

As decisões de 31/08 a 08/09/2026 estão, sem alteração de conteúdo, em [`history/pre-final-1/DECISIONS.md`](history/pre-final-1/DECISIONS.md), blob de origem `32c4b5126563c72593a0f368d80431332bda642d`.

Permanecem particularmente aplicáveis BN-DEC-002 (shell/HeroUI), BN-DEC-005 (arquivos reais), BN-DEC-008 (regra única), BN-DEC-010 (Desempenho read-only), BN-DEC-014 (privacidade), BN-DEC-019/020 (separação de autoridade e decisões humanas) e BN-DEC-021 (PostgreSQL via Hyperdrive), observadas as substituições abaixo.

## BN-DEC-022 — Consolidação relacional e programa final

**Data:** 2026-09-10. **Origem:** decisões e homologações da #613; #625/#627/#629 e PRs #626/#628/#630; arquivamento #631/#632; programa final autorizado e registrado em #182/#633/#634/#635/#406/#347/#596.

Esta decisão consolida mudanças já aprovadas e define sua precedência documental. Não aplica DDL, não ativa endpoints, não muda dados ou autoridade por sua publicação.

### Substituições expressas

**Substitui BN-DEC-021**, exclusivamente no roteiro executável da migração física e na suposição de equivalência do modelo `streams/versions`: a #613 reconstruiu e homologou o schema relacional simplificado como autoridade de persistência. A sequência antiga de backfill/shadow não será reexecutada nem seu schema recriado. PostgreSQL/Supabase via Hyperdrive `PROD_DB`, backend autorizado, privacidade, menor privilégio e recuperação continuam obrigatórios. D1 antigo não é automaticamente backup das novas escritas.

**Substitui BN-DEC-017**, apenas quanto à representação física de versões: estado atual em tabelas relacionais e histórico de deltas reais, sem exigir streams/versions nem duplicação integral de payloads. Identidade lógica, detecção de alteração semântica, atomicidade e idempotência continuam. Reimportação idêntica não gera DML/histórico acadêmico; pode atualizar diagnósticos operacionais, que são outro conjunto de dados.

**Substitui BN-DEC-006 e a obrigação de retenção de ocorrências de BN-DEC-019**, somente para diagnósticos de importação conforme #629: manter evidências atuais da última leitura do arquivo/ano; apagar as resolvidas ao substituir esse conjunto; adicionar as novas ou ainda presentes. Não existe histórico de resolvidos. Essa exceção não apaga histórico acadêmico, deliberações humanas nem registros oficiais emitidos, e nunca permite alterar a planilha original.

**Complementa BN-DEC-007/019/020**: o motor simplificado e suas projeções existem; o cutover de persistência não prova aceite acadêmico de todos os consumidores. A #347 deixa de ser uma repetição da migração física e mantém a aprovação por consumidor/escopo, versão/vigência e recuperação, com evidências do piloto #406. Não são autorizados flip global, reinterpretação retroativa, escolha de autoridade pelo browser ou eliminação automática de AM/U.

**Atualiza o sequenciamento de BN-DEC-011/012** para quatro entregas grandes: FINAL-1 #633, FINAL-2 #634, FINAL-3 #635, FINAL-4 #406; aceite #347 e entrega #596. Issue/branch/PR, contratos explícitos, revisão e integração autorizada permanecem. PR parcial não encerra a fase inteira.

### Modelo e semântica consolidados

A Relação é o cadastro mestre anual. Pessoa e vínculo são separados; número não é reutilizado naquele vínculo. Oferta tem identidade ano/turma/disciplina/professor; slot identifica instrumento, não sua descrição. Armazenar fatos em inteiros de milésimos; não persistir somas derivadas. `0,1` de fonte é zero acadêmico; zero manual/de fórmula e branco têm semântica de vazio. Limpeza em escopo completo remove o valor atual com histórico; indisponibilidade não inventa zero nem apaga anterior. `N/C` é exclusivo da REC e permanece distinto de valor numérico. Descrição vazia preserva a anterior. Valor acima do máximo é aviso conforme revisão posterior da #613, não bloqueio pela redação inicial superada do corpo da issue.

`fechamento.am*_fonte` e `u_fonte` são referências independentes de comparação. REC é fato permanente; substitui a nota normal somente no cálculo correspondente. Decisão humana de Conselho não é fórmula. Todos os detalhes acadêmicos permanecem definidos pelo núcleo/contratos e decisões da #613, não por esta síntese documental.

São 19 tabelas centrais e uma de diagnósticos. Uma lacuna institucional real de persistência exige proposta mínima e contrato explícito; o número 19 não é motivo para omitir voto/fechamento/snapshot nem para reconstruir o modelo antigo inteiro.

### Fontes funcionais e lacunas

O documento `PAINEL DESEMPENHO` de 29/08/2026 é a referência funcional de Desempenho. Do documento antigo `APENAS CONSELHO` de 23/08/2026, somente o conteúdo de Conselho é preservado como referência funcional. O restante não governa novamente importação, persistência ou Auditoria.

Há diferenças entre o Conselho documental, os códigos atuais de decisão e o contrato institucional V2 antigo. Distinção entre reprovações, voto opcional/desempate, edição/reabertura e fechamento exigem conciliação explícita na #635 por issue de contrato. Não inferir equivalência entre estados diferentes, diretor a partir de administrador nem fatos históricos inexistentes.

### Critério de verdade

Distinguir: fonte normativa, implementação na branch, código integrado, publicação, uso produtivo e homologação. `PROJECT_STATE.yaml` registra a baseline auditada, não flags produtivas inferidas. O mapa de consumidores é um diagnóstico estático dos caminhos, não um teste HTTP autenticado. Testes históricos leem documentos históricos; testes atuais não exigem que a documentação continue descrevendo D1 canônico ou produção OFF.

## BN-DEC-023 — Integração e deploy das entregas concluídas

**Data:** 2026-09-10, 12:31 UTC. **Origem:** autorização explícita do responsável na conversa; registro na #182, comentário `5618750384`. Inclui a remediação de dependências #637.

**Substitui a exigência de confirmação individual de merge/deploy** dos roteiros anteriores, inclusive das #633/#639 e PRs #636/#640, para as entregas do escopo de desenvolvimento aprovado neste repositório. Concluir, revisar, integrar e publicar **sem nova confirmação por PR**. A autorização permanece até revogação ou alteração do escopo pelo responsável.

O fluxo continua: issue e contrato quando necessário → branch curta → revisão do diff → `npm run verify`/CI no head final → merge com SHA esperado → deploy pelo workflow oficial → verificação/checkpoint. Falhas de validação, conflitos ou regressões materiais interrompem a publicação. Não contornar checks, aprovações exigidas pela proteção ou limites de autorização; não habilitar merge incondicional nem criar orquestrador permanente.

Não amplia autorização para apagar dados/recursos, executar migrations destrutivas, alterar regras ou autoridade acadêmica, ACL/RLS, pessoas/permissões, secrets, proteções de branches ou infraestrutura. Essas decisões continuam próprias. Deploy aprovado não é aceite acadêmico #347, piloto #406, teste de restore ou smoke autenticado/visual: registrar evidência e limitação separadamente. PR parcial não encerra FINAL-1.

## BN-DEC-024 — Ano letivo 2026 fixo e comparação somente entre trimestres

**Data:** 2026-09-10. **Origem:** decisão explícita do responsável; #649 e PR #650. Complementa BN-DEC-022/023 e substitui os planos correntes de criação/seleção de anos e de comparabilidade ainda não decidida em #633/#634/#646.

O produto ativo fica restrito ao ano letivo **2026** nesta etapa. Remover criação/gestão de anos, seletor global, catálogo usado para escolha, preferência no browser e qualquer comparação entre anos letivos. Centrais relacionais, Desempenho e importação canônica recusam outro ano antes de ler ou persistir. `ano`/`ano_letivo` permanecem como chaves estruturais, FKs e isolamento; não apagar schema/histórico nem executar mudanças de dados produtivos. A materialização técnica do único registro 2026 pela importação da Relação continua permitida quando necessária às FKs do mesmo fluxo, sem abrir criação de outro ano.

Comparações são apenas entre trimestres de 2026: T2→T1 e T3→T1 ou T2, com referência escolhida explicitamente. Comparar o mesmo aluno, turma, componente, lente e modo pela proporção `valor/máximo oficial positivo`; relação exata maior/igual/menor e diferença em pontos percentuais. Zero participa e valores acima de 100% não são limitados. Resultado, Quantitativo e Qualitativo são elegíveis; Avaliações por slot, T1 e Visão geral não são.

Leitura excluída, parcial, vazia, N/C, recuperação pendente, não aplicável, indisponível ou sem máximo positivo não recebe comparação. Não criar tolerância, tendência, ranking, equivalência de instrumentos, melhora/piora pedagógica ou nova regra acadêmica. A autoridade é observação descritiva sobre a projeção calculada, nunca emissão oficial.

Atual e referência devem nascer do mesmo snapshot PostgreSQL read-only/repeatable-read e do mesmo conjunto de fatos, sem N+1. Seleções ficam em memória e respostas obsoletas são canceladas/descartadas. Os registros atuais do banco podem servir como massa de teste, mas não como dados oficiais ou aceite institucional. A validação visual de FINAL-1/FINAL-2 será única e feita depois com o responsável; avisá-lo imediatamente antes de iniciá-la.

## BN-DEC-025 — Configuração docente vem da fonte e ordem curricular é única

**Data:** 2026-09-11. **Origem:** continuidade autônoma autorizada pelo responsável; #660. Complementa BN-DEC-022/024 e encerra a adaptação pendente da manutenção docente em #633.

Professor, componente e oferta de 2026 são reconhecidos e materializados pelas planilhas importadas. Não criar cadastro manual paralelo, nomes alternativos, confirmação, vigência ou versões ausentes do schema simplificado. A Central de professor é a configuração docente relacional: consulta as ofertas reconhecidas e orienta correções pela fonte/importação. O transporte `maintenanceVersion: 1`, próprio do modelo antigo, deixa de ser servido antes de instanciar aquele runtime; os arquivos exclusivos sem consumidor foram retirados após prova estática de dependência, preservados pelo histórico Git.

A ordem de apresentação dos componentes é a observada em `CONFIGURAÇÃO`/`CONFIGURAÇÕES!H3:I16`: P, M, H, G, C, A, RL, RD, F, ET, I e CT. Desempenho, Boletins, resultados anuais e Centrais usam a mesma função. Componente desconhecido fica depois, em ordem estável, sem sigla/posição inventada. Ordem não integra a identidade acadêmica e não autoriza arraste manual de colunas.

Esta decisão não altera importador, dados/schema de produção, cálculo, regras ou autoridade oficial. Uma futura edição cadastral dentro da aplicação exigiria contrato, durabilidade e decisão próprios; não pode reaproveitar silenciosamente o modelo V1.

## BN-DEC-026 — Trilha humana mínima sem resolução manual de achado

**Data:** 2026-09-11. **Origem:** decisão final da #613 sobre achado corrente × histórico de tratamento; autonomia de produto delegada pelo responsável; contrato #674. Complementa BN-DEC-022 e substitui apenas a lacuna declarada pela #658.

A Auditoria mantém duas verdades independentes. `importacao_diagnostico` continua sendo o snapshot substituível das pendências atuais. A trilha humana é append-only e oferece somente `RECONHECIDO` e `ANOTAÇÃO`. Não criar estado ou botão manual `RESOLVIDO`, `IGNORADO` ou `DESCARTADO`: o achado sai das pendências apenas quando a fonte é corrigida e reimportada. A ação humana nunca altera fato acadêmico nem oculta diagnóstico.

O histórico preserva contexto mínimo sem duplicar o nome do aluno; ator é o OID UUID da sessão, horário é server-side e comandos são idempotentes. Ano fixo 2026, endpoint administrativo/no-store e ACL privada de `SELECT, INSERT`, sem `UPDATE/DELETE` ou acesso público/cliente.

Esta decisão autoriza contrato e implementação em branch/PR. **Não autoriza aplicar o DDL em produção**: a migration aditiva e o código dependente aguardam a autorização explícita de schema preservada pelo responsável.

## BN-DEC-027 — Autorização e aplicação da trilha humana da Auditoria

**Data:** 2026-09-11. **Origem:** autorização explícita do responsável após a PR #675 ficar verde. Complementa BN-DEC-026 e encerra exclusivamente seu gate de DDL.

Fica autorizada a migration aditiva `0006_import_diagnostic_treatment_v1.sql` em produção e a integração/publicação do código dependente após os gates da BN-DEC-023. A autorização não alcança outro schema, backfill, mudança de dado acadêmico, resolução manual de achado, regra, autoridade, binding, segredo, permissão de pessoa ou infraestrutura.

Antes do DDL foi capturado um dump lógico privado e seu restore foi comprovado em PostgreSQL descartável. O preflight confirmou a baseline `29/227/203/62/51`, 12 sequências, somente 2026 e alvo ausente. A migration registrada `import_diagnostic_treatment_v1` levou o catálogo a `30/246/218/66/52` e 13 sequências; a relação nasceu vazia, com ACL `SELECT, INSERT` somente para `gradebook_app`, sem `UPDATE/DELETE` nem acesso de `PUBLIC`, `anon` ou `authenticated`. Funções, triggers e contagens acadêmicas permaneceram iguais. O Advisor de segurança terminou sem alertas; avisos de índice não utilizado na relação vazia são esperados antes do primeiro uso.

## BN-DEC-028 — Anos materializados pela Relação e reprovação terminal R/R

**Data:** 2026-09-11. **Origem:** decisão explícita do responsável; contrato #676. Substitui BN-DEC-024 somente quanto ao ano fixo e à ausência de seleção global; complementa BN-DEC-022/025–027. Comparação entre anos continua proibida.

A importação da Relação materializa idempotentemente o ano letivo declarado. Planilhas de notas somente ingressam depois da Relação do mesmo ano e nunca são reinterpretadas em outro ano. Aluno, vínculo, turma, oferta, fatos, diagnósticos, Conselho, fechamento, boletim e relatório permanecem isolados por `ano`; a mesma pessoa nominal em anos diferentes recebe IDs distintos e não é unida pelo nome.

O shell oferece um único seletor global, alimentado pelos anos já materializados e mantido somente em memória. O ano mais recente abre por padrão. Trocar o ano invalida leituras anteriores e todas as áreas passam a operar no novo contexto sem seletores locais. Comparações continuam restritas a trimestres do mesmo ano, conforme a regra proporcional da BN-DEC-024.

`R/R` é um marcador de fonte exclusivo da Recuperação e distinto de nota, vazio e `N/C`. Se aparecer em qualquer trimestre de recuperação de qualquer componente, o resultado anual do aluno é exatamente `REPROVADO`, sem recuperação pendente e sem elegibilidade ao Conselho. A ocorrência é preservada em máscara própria e histórico de fechamento; não é convertida em voto nem decisão humana. AM/U importadas continuam autoridade oficial e o Conselho continua humano somente para elegíveis.

A migration `0007_multiyear_rr_v1.sql` é aditiva: acrescenta a máscara R/R, amplia os estados históricos e remove apenas as duas restrições físicas que fixavam snapshots/tratamentos em 2026. Não executa backfill, `UPDATE`, `DELETE` ou reinterpretação retroativa. Detalhes em [MULTIYEAR_RR_676.md](MULTIYEAR_RR_676.md).

## BN-DEC-029 — Aplicação da extensão multi-ano/R/R sem backup gerenciado

**Data:** 2026-09-11. **Origem:** autorização explícita do responsável na #676 e decisão de adiar backup gerenciado. Complementa BN-DEC-028 e encerra exclusivamente o gate de DDL da `0007`.

A migration `0007_multiyear_rr_v1.sql` foi aplicada em produção como `multiyear_rr_v1`, versão `20260911201622`, depois de replay PostgreSQL descartável e preflight exato. A operação não criou backup gerenciado por decisão consciente do responsável; essa limitação permanece fora do aceite de recuperação operacional e não autoriza presumir RPO/RTO.

O preflight confirmou catálogo `30/246/218/66/52`, 13 sequências, somente 2026 materializado, coluna alvo ausente e as oito constraints históricas esperadas. O postflight confirmou `30/247/221/66/52`, 13 sequências, 4 funções e 3 triggers; todas as contagens acadêmicas permaneceram idênticas, os 4.463 fechamentos existentes ficaram com `rec_rr_mask = 0`, nenhuma máscara R/R foi inventada e nenhuma constraint obsoleta permaneceu. O Advisor de segurança terminou sem alertas.

## BN-DEC-030 — Configurações, reset anual e vínculo Em curso

**Data:** 2026-09-12. **Origem:** solicitação explícita do responsável; contrato #688. Complementa BN-DEC-022/023/026/028/029 e cria uma exceção deliberada de retenção somente para o reset anual confirmado.

O Banco de Notas passa a ter a área **Configurações**. Sua primeira operação administrativa é `Resetar o sistema`: limpar integralmente um único ano letivo materializado, escolhido pelo seletor global, para permitir novo lançamento a partir das planilhas. Não existe reset global, reset de sequências, `DROP`, `TRUNCATE`, reconstrução de schema ou efeito sobre outro ano.

O reset anual é uma ação excepcional e explícita. Prévia somente leitura enumera as contagens; execução exige a frase exata `RESETAR <ano>`, confirmação de irreversibilidade e a mesma revisão da prévia. O servidor autentica a capability administrativa, confere origem/provider/gate e executa o conjunto em transação serializável com bloqueio. Mudança desde a prévia, ano ausente ou qualquer falha encerram sem exclusão parcial.

Para esse comando confirmado, “tudo referente ao ano” inclui cadastro anual, vínculos, ofertas, instrumentos, notas, fechamentos, importações, diagnósticos e tratamentos, deliberações/fotografias do Conselho, boletins emitidos e históricos atribuíveis ao ano. Esta decisão substitui a retenção append-only da BN-DEC-022/026 **somente durante esse reset anual deliberado**. Diagnóstico sem ano permanece porque não pode ser atribuído com segurança. Ao final, o próprio registro `ano_letivo` é removido; o ano só volta ao catálogo quando uma Relação o materializa novamente.

A migration `0008_year_reset_acl_v1.sql` autoriza somente `DELETE` nas dez relações posteriores que tinham ACL append-only; não concede `ALL`, `TRUNCATE`, DDL, acesso público/cliente ou permissão a usuário. A aplicação/publicação da ACL fica autorizada como parte da entrega #688 sob os gates da BN-DEC-023. Isso não autoriza executar um reset produtivo durante desenvolvimento, deploy ou smoke; cada execução continua dependendo da confirmação final do operador na própria interface. A ausência de backup gerenciado deve permanecer visível e não pode ser apresentada como resolvida.

Na matriz de Desempenho, `vinculo.situacao = NULL` significa vínculo regular vigente e é apresentado como **Em curso**. É rótulo de interface derivado da Relação, não nova situação persistida nem resultado acadêmico. A limpeza de código permanece seletiva: não adicionar fallback legado e não remover contratos ainda consumidos apenas por semelhança de nome.

A ACL foi aplicada em produção como `year_reset_acl_v1`, versão `20260912004843`, sem DML. O preflight confirmou as dez relações alvo, os dois anos materializados e ausência de `DELETE`; o postflight preservou integralmente as contagens anuais e o catálogo `30/247/221/66/52`, com 13 sequências, 4 funções e 3 triggers. `gradebook_app` recebeu somente `DELETE` adicional nessas relações, `PUBLIC`/`anon`/`authenticated` permaneceram sem grants e o Advisor de segurança terminou sem alertas. Nenhum reset produtivo foi executado.

## BN-DEC-031 — Observação granular, zero real e nomes de avaliações

**Data:** 2026-09-16. **Origem:** pedido explícito do responsável na conversa; #817 / PR #818. Substitui a semântica zero=vazio da BN-DEC-022 exclusivamente nos intervalos granulares AV1/AV2/PARA/atividades 1–10 do novo produtor canônico identificado.

Célula efetivamente lida em branco significa atividade não realizada; zero digitado ou resultado numérico zero de fórmula significa zero acadêmico. Indisponível, instrumento inativo e fonte ainda não observada não significam “Não fez”. O marcador legado 0,1 continua zero; AM/REC/U não recebem a nova conversão. Linha atual com nota NULL e flags históricos registram a observação sem reconstruir fatos antigos descartados. O produtor sem a nova identificação preserva a compatibilidade. Não há backfill automático; reimportação é necessária quando a informação anterior foi perdida.

A interface granular do Banco e do Portal apresenta “Não fez” e “Tirou zero”, sem substituir a nota trimestral, a autoridade imported-source ou decisões humanas. O cadastro Nomear avaliações define seis nomes por ano/trimestre/AV1–2, com CAS, coordenação e evento transacional. Os nomes são apresentação, nunca identidade nem nova fórmula; podem atualizar rótulos já publicados sem trocar os resultados. Boletins emitidos mantêm seu snapshot. Autosave de nascimento continua sendo uma escrita autorizada, validada e rastreável; simplificação visual não elimina as confirmações de operações críticas.

A entrega inclui as migrações aditivas mínimas descritas em [STUDENT_EXPERIENCE_817.md](STUDENT_EXPERIENCE_817.md), sem reset/reimportação/backfill produtivo durante desenvolvimento. Gates de integração/publicação permanecem BN-DEC-023; DDL e verificação produtiva devem constar separadamente no checkpoint. Não autoriza migração destrutiva, mudança de ACL/identidade/secrets ou alteração de regras acadêmicas fora dos slots explicitamente pedidos.

## BN-DEC-032 — 0,1 como nota decimal comum

**Data:** 2026-09-17, 13:35 UTC. **Origem:** determinação explícita do responsável; contrato #837. Substitui exclusivamente a convenção de marcador 0,1 das BN-DEC-022/031 no caminho ativo de novas importações.

`0,1` é número comum: leitura manual, texto decimal com vírgula/ponto e resultado numérico salvo de fórmula preservam **100 milésimos**, participantes de somas, médias e indicadores conforme seus critérios existentes. Não converter esse valor em zero nem preferir uma normalização antiga ao escalar bruto recém-observado. A nova identificação do produtor inclui `decimal-grades-v1`.

Nos instrumentos granulares, vazio observado permanece “Não fez” e zero real permanece “Tirou zero”, como na BN-DEC-031. Fonte indisponível ou fórmula sem cache não recebem nenhum desses diagnósticos e não apagam o valor anterior. A remoção da sentinela 0,1 também alcança os valores decimais de AM/REC/U, sem modificar os outros estados ou a convenção separada de zero/vazio desses campos. Não altera N/C, R/R, aplicabilidade da recuperação, pesos, máximos, arredondamento final ou autoridade imported-source.

Zeros anteriormente gravados não são convertidos por suposição: é necessária reimportação de uma fonte que ainda contenha 0,1. Históricos, contratos antigos e boletins emitidos permanecem interpretáveis em seu contexto. A atualização do Portal segue as políticas existentes, sem republicação forçada. Não autoriza backfill, DML direto ou mudança de schema em produção. Implementação e regressões em [DECIMAL_GRADES_837.md](DECIMAL_GRADES_837.md); integração e publicação seguem BN-DEC-023, com validação manual no navegador a cargo do usuário.

## BN-DEC-033 — Elegibilidade e composição da recuperação paralela

**Retificação vigente:** a composição aditiva desta entrada foi uma interpretação equivocada do executor, expressamente corrigida pela BN-DEC-035/#850. O texto abaixo é preservado como histórico de implementação, não como autorização para somar Q+PARA.

**Data:** 2026-09-17, 23:12–23:14 UTC. **Origem:** regra e composição explicitadas nesta conversa, seguidas da ordem de execução imediata; contrato #844. Substitui no núcleo ativo a exigência de AV1/AV2 preenchidas e a composição anterior por substituição do quantitativo pela PARA. Não altera o histórico documental nem a REC final.

Q = AV1 + AV2; L = qualitativo. Ausência contribui zero à aritmética, sem converter o fato NULL em nota zero. Elegível somente se Q < 60% de 13,5/13,5/18 E Q + L < 60% de 30/30/40. Usar limites institucionais e total exato anterior à PARA, sem arredondar, sem exigir qualquer das duas notas e sem circularidade. Igualdade com qualquer limite dispensa a paralela. Definições estruturais ausentes continuam indisponíveis; cobertura permanece separada da elegibilidade.

Conforme a composição explicitada e aprovada na conversa, se elegível e PARA > Q, somar PARA uma única vez ao quantitativo original: bruto = Q + PARA + L. Caso contrário, bruto = Q + L. Preservar `rawMilli` e o arredondamento homologado em `roundedMilli`; o detalhe pode apresentar a soma exata pelo opt-in `includeRawSum: true`, sem fórmula na UI nem alteração do formato recebido por clientes antigos. Um benefício registrado não pode ser ocultado apenas porque as avaliações regulares estão ausentes.

Esta mudança alcança o cálculo descritivo corrente, não sobrescreve AM/U importadas, não muda decisões humanas ou snapshots emitidos e não executa DML/DDL, backfill, reimportação ou republicação forçada. Regras, exemplos sintéticos, consumidores e testes em [PARALLEL_RECOVERY_844.md](PARALLEL_RECOVERY_844.md). Gates de integração/publicação continuam BN-DEC-023; CI, deploy e smoke devem ser comprovados separadamente.

## BN-DEC-034 — PARA visível e exigível somente para elegíveis

**Exceção vigente:** BN-DEC-035/#850 determina que PARA numérica, inclusive zero, seja respeitada mesmo sem elegibilidade normal. O caso sem elegibilidade e sem nota continua oculto; pendências de outros instrumentos permanecem independentes.

**Data:** 2026-09-18, 00:45 UTC. **Origem:** determinação explícita do responsável; contrato #848. Complementa BN-DEC-031/033 e substitui a exclusão incondicional da PARA da cobertura de lançamentos. Não modifica os limites, a composição aditiva ou o arredondamento da BN-DEC-033.

Nas listas individuais, a PARA só aparece quando `parallelApplicable === true` no núcleo. Existência de nota, zero ou vazio observado não contorna a elegibilidade. Para elegíveis, vazio observado é “Não fez” e zero numérico é “Tirou zero”; ausência de observação não autoriza inventar “Não fez”. O fato original continua armazenado mesmo quando a linha é ocultada.

A PARA integra `coverage.requiredSlots` somente quando o instrumento existe no trimestre e o aluno é elegível. Valor nulo mantém o instrumento pendente; qualquer valor numérico, inclusive zero e nota sem ganho, resolve esse instrumento. PARA não elegível não cria pendência. Os asteriscos, estado parcial e consumidores de cobertura devem seguir a saída do núcleo; não apagar ausências em outras avaliações/atividades, inventar instrumento inexistente ou transformar período inteiramente vazio em nota zero.

A matriz compartilhada de avaliações pode manter a coluna PARA quando há elegíveis no recorte visível, mas não revela valor ou “Não fez” nas células não elegíveis. Sem elegíveis, a coluna e o resumo de instrumento são omitidos. Resultado, dimensão quantitativa considerada, estatísticas, comparações e novas prévias de Boletim reutilizam a cobertura aplicável, sem fórmula paralela na UI.

O Portal aplica o filtro aos fatos da edição aprovada, sem consultar notas novas para substituir uma publicação anterior. Notas oficiais AM/U, calendário, permissões, opção de parciais, autoUpdate, períodos publicados e snapshots já emitidos são preservados. Não há DML/DDL, reimportação ou republicação forçada nesta entrega. A orientação #846 permanece: não acrescentar comentários explicativos às telas. Mapa de consumidores e regressões em [PARALLEL_VISIBILITY_848.md](PARALLEL_VISIBILITY_848.md); revisão, CI e deploy seguem BN-DEC-023.

## BN-DEC-035 — PARA melhora o quantitativo e respeita nota lançada

**Data:** 2026-09-18, 09:39–09:57 UTC. **Origem:** esclarecimento e confirmação explícitos do responsável; contrato #850. Retifica a interpretação aditiva do executor na BN-DEC-033/#844 e acrescenta a única exceção à ocultação da BN-DEC-034/#848. A composição Q+PARA nunca foi a intenção confirmada pelo responsável.

Quantitativo original Q é somente AV1 + AV2. PARA é uma chance de melhorar esse quantitativo; não é uma terceira avaliação adicional e não aumenta o máximo. Elegibilidade normal E mantém Q < 8,1 E Q+L < 18 em T1/T2; Q < 10,8 E Q+L < 24 em T3, com limites exatos antes de PARA/arredondamento e sem exigir notas em qualquer AV.

Nota numérica P lançada pelo professor, inclusive zero, é a única exceção: aparece e participa da comparação mesmo sem E. Vazio não aciona exceção. `parallelApplicable` passa a representar a aplicabilidade efetiva E OU P numérica. Se P > Q, quantitativo considerado = P; caso contrário = Q. **Bruto = max(Q,P) + L**, ou Q+L sem P. Ganho = max(P-Q,0). Exemplo confirmado: Q=4, P=7, L=10 -> 17, não 21. Arredondamento permanece na função homologada.

Cobertura e exibição seguem o mesmo núcleo: PARA existente/elegível nula é pendência; zero/nota resolve somente PARA; ausência sem observação não vira Não fez. Sem E e sem P, ocultar e não criar pendência. Com P, mostrar a nota ou Tirou zero, inclusive nos recortes e resumos compartilhados. A exceção já está resolvida e não apaga outras pendências. Não emitir aviso de PARA proibida para a exceção agora permitida; preservar decodificação histórica.

Cálculos de resultado usam o quantitativo considerado; diagnósticos das duas avaliações preservam Q original. Portal usa fatos da edição aprovada, sem consultar notas atuais para substituir a edição. AM/U importadas, snapshots e fatos/históricos não são sobrescritos; sem DML/DDL, reimportação, backfill ou republicação forçada. Não acrescentar comentários técnicos às telas. Detalhes e testes em [PARALLEL_QUANTITATIVE_850.md](PARALLEL_QUANTITATIVE_850.md). Revisão e publicação seguem BN-DEC-023; CodeRabbit pode auxiliar somente nesta correção, conforme escopo explícito da #850, sem autorização permanente.

## BN-DEC-036 — Correções qualitativas fechadas de 2026 e T3 em andamento

**Data:** 2026-09-18. **Origem:** auditoria de contagens #852 e autorização explícita do responsável para corrigir as pendências; #855. Complementa BN-DEC-022/031/032/035 sem alterar fórmula acadêmica.

A divergência de máximo qualitativo é corrigida somente quando a causa é determinística em trimestre encerrado. T3 permanece em andamento até 16/12/2026 e não recebe máximos, atividades ou completude inventados. Educação Física 6B, Português 6C/6D e Redação 7D em T3 ficam fora da correção desta decisão.

Nos 12 oferta-trimestres fechados de T1/T2 investigados, uma definição de Ética 6A/T2 é restaurada de 3,0 para 6,0 porque há histórico anterior em 6,0 e lançamentos válidos até esse valor. Os demais excessos são slots qualitativos extras sem nenhuma nota numérica; esses slots deixam de ser ativos, e suas observações vazias atuais são convertidas de observado-em-branco para não observado com histórico explícito. Nenhuma nota numérica é apagada ou alterada.

A correção é durável no importador por manifesto estreito de ano/professor/turma/componente/trimestre/slot. Qualquer mudança futura na definição investigada ou qualquer evidência de lançamento em slot suprimido bloqueia a normalização e exige nova investigação; não mascarar fonte nova. A normalização é aplicada no produtor canônico e novamente no servidor antes da persistência.

A migration 0010 registra importação de correção, instrumento_historico e nota_historico, remove somente diagnósticos correntes comprovadamente resolvidos e emite a revisão acadêmica existente do Portal quando essa integração está instalada. Boletins emitidos, AM/U, REC, PARA e decisões humanas permanecem intactos. Detalhes e testes em QUALITATIVE_CORRECTIONS_855.md.


## BN-DEC-037 — RLS de defesa em profundidade no schema gradebook

**Data:** 2026-09-18. **Origem:** auditoria de segurança e autorização explícita do responsável para corrigir a pendência; #856 / PR #858. Complementa as ACLs privadas existentes sem mudar autoridade acadêmica, identidade ou fórmula.

As 30 tabelas do schema `gradebook` passam a usar Row Level Security. Antes desta decisão, `PUBLIC`, `anon` e `authenticated` já não possuíam USAGE/CRUD efetivo no schema, portanto a auditoria não identificou exposição direta por esses papéis. RLS acrescenta uma segunda camada de defesa, sem substituir grants.

Cada tabela recebe a policy `gradebook_app_backend_v1`, restrita à role dedicada `gradebook_app`, com `USING (true)` e `WITH CHECK (true)`. Essa policy não concede operações: SELECT/INSERT/UPDATE/DELETE continuam limitados pela ACL específica de cada relação. `gradebook_app` permanece NOSUPERUSER/NOBYPASSRLS. Não usar `FORCE ROW LEVEL SECURITY`; migrations/proprietário e papéis administrativos continuam com sua semântica PostgreSQL própria. `PUBLIC`, `anon` e `authenticated` permanecem explicitamente revogados no schema, tabelas e sequências.

A migration falha se o conjunto esperado de 30 tabelas mudar ou se `gradebook_app` estiver ausente/com BYPASSRLS, obrigando futuras tabelas a receber decisão explícita em vez de proteção presumida. Produção recebeu `gradebook_rls_v1` na versão Supabase `20260918114401`; postflight confirmou 30/30 tabelas com RLS ON, FORCE OFF, 30 policies, 112 grants backend preservados, zero grants anon/auth e contagens acadêmicas inalteradas. O Advisor de segurança terminou sem alertas.

O schema `student_portal` não é incluído automaticamente. A auditoria verificou zero acesso direto de anon/auth às 27 tabelas atuais e abriu #859 para avaliar RLS com matriz própria de runtime, autenticação, publicação e jobs. Detalhes e regressões em [GRADEBOOK_RLS_856.md](GRADEBOOK_RLS_856.md).

## BN-DEC-038 — Importação autoritativa do estado atual da planilha

**Data:** 2026-09-18. **Origem:** determinação explícita do responsável; #862. Substitui a preservação conservadora de definição anterior quando uma célula de definição foi realmente observada vazia e retifica a durabilidade da trilha humana da BN-DEC-027. Não altera fórmula acadêmica, AM/U, REC, PARA, Conselho ou snapshots de boletim.

Cada nova importação de notas é a fotografia atual da fonte. Máximo, nome e nota observados substituem o estado corrente do mesmo slot. Instrumento qualitativo com máximo/nome realmente apagados e sem qualquer lançamento deixa de integrar o payload já no navegador e deve ser removido do PostgreSQL; uma coluna retirada não deixa nota NULL nem definição vazia para trás. Branco de aluno em instrumento ativo continua sendo fato atual “Não fez” e permanece distinto de coluna excluída.

Vazio observado e indisponibilidade técnica são estados diferentes. Campo realmente lido vazio é autoritativo. Campo/célula que não pôde ser lido preserva somente aquele dado anterior e gera diagnóstico com guia, célula, causa e correção sugerida. O Transport V9 permanece compatível e usa definitionSnapshotVersion 1, unavailableMaximumSlots, unavailableDescriptionSlots e unavailableValueSlots; requests antigos sem o marcador preservam a semântica anterior.

Importações novas deixam de criar nota_historico e instrumento_historico; essas relações passam a ser legado vazio após a limpeza #863. A importacao continua podendo registrar a operação atual e os históricos de fechamento/vínculo permanecem fora desta decisão.

A Auditoria continua fotografia atual. Se a nova observação não contém mais uma chave diagnosticada, qualquer reconhecimento/anotação correspondente também é removido na mesma substituição; BN-DEC-027 deixa de autorizar tratamento humano órfão. O manifesto específico da #855 é retirado: a correção produtiva realizada naquela entrega permanece, mas futuras planilhas são governadas pela fotografia atual, não por exceções fixas de professor/turma. Detalhes e regressões em [AUTHORITATIVE_IMPORT_862.md](AUTHORITATIVE_IMPORT_862.md).

## BN-DEC-039 — Sem histórico granular de nota/instrumento no estado corrente

**Data:** 2026-09-18. **Origem:** determinação explícita do responsável; #863. Complementa BN-DEC-038 e substitui a retenção histórica granular de nota/instrumento das decisões anteriores. Não altera a autoridade de AM/U, REC, PARA, Conselho ou boletins.

`nota_historico` e `instrumento_historico` deixam de ser parte operacional do Banco de Notas. Seus dados acumulados são apagados e novas importações não gravam valores anteriores de nota, máximo ou descrição. O estado atual autoritativo é a última fotografia válida da planilha.

As duas relações físicas permanecem temporariamente vazias para compatibilidade de schema, reset e restore. `gradebook_app` mantém leitura/exclusão, mas perde INSERT/UPDATE; o buffer de importação rejeita tentativa de writer granular. Uma futura remoção física das tabelas exige migration separada.

Linhas `nota(NULL)` não são lixo por si só: se pertencem a instrumento atual, representam observação vazia/“Não fez” e permanecem. Instrumento qualitativo sem máximo, sem descrição e sem qualquer observação é resíduo e pode ser removido. `fechamento_historico`, `vinculo_historico`, Conselho e snapshots de boletim permanecem fora desta limpeza.

`importacao` deixa de ser criada para mudanças de estado atual sem histórico retido. Linhas antigas sem qualquer referência retida são removidas; linhas necessárias por histórico de fechamento/vínculo permanecem. Auditoria corrente não conserva tratamento órfão.

Detalhes, preflight e pós-flight em [CURRENT_STATE_CLEANUP_863.md](CURRENT_STATE_CLEANUP_863.md).

## BN-DEC-040 — Reset anual não conserva coordenação técnica do ano removido

**Data:** 2026-09-18. **Origem:** auditoria produtiva e determinação explícita do responsável; #870. Substitui somente a cláusula anterior de #703/#706 que fazia `academic_revision` e provas técnicas sobreviverem ao reset.

Quando `Resetar o sistema` conclui com sucesso, o ano deixa de existir também no estado técnico diretamente atribuível a ele: `student_portal.revision_event`, `student_portal.year_reset_preview_proof` e `student_portal.academic_revision` são removidos na mesma transação, depois de o token consumido e as pós-condições acadêmicas terem sido validados. Nenhuma dessas linhas é necessária para representar um ano inexistente.

O guard de contas Portal permanece: qualquer conta com vínculo acadêmico vivo bloqueia preview/execute. Contas, credenciais, sessões, auditoria de identidade e tombstones de vínculo não são apagados por conveniência. Diagnósticos sem ano continuam preservados. Diagnóstico com ano explícito só é persistido se o ano estiver materializado sob o lock anual, evitando que uma planilha antiga recrie revisão depois do reset; a primeira Relação confirmada repete sua Auditoria após materializar o ano. Uma nova Relação é a autoridade para rematerializar o ano; seu escritor recria a coordenação anual sob os mesmos locks antes das novas escritas.

O contrato V1 não ganha campos: suas contagens e `deletedRows` permanecem acadêmicos para compatibilidade, enquanto a ausência de resíduos técnicos passa a ser pós-condição interna obrigatória. Detalhes e regressões em [YEAR_RESET_SETTINGS.md](YEAR_RESET_SETTINGS.md).

## BN-DEC-041 — Retirada autorizada da compatibilidade D1

**Data:** 2026-09-21. **Origem:** autorizacao explicita do responsavel depois do
inventario B-16/#1078; contrato #1079. Substitui somente a preservacao operacional
do runtime D1/transportes legados descrita nos mapas anteriores, nao o dominio
ou os tipos compartilhados ainda usados pelos consumidores atuais.

Workspace V1, Performance V1, Boletins V1, Relatorios V1 e Conselho V1/V2 sao
retirados em todos os ambientes. Requisicoes validas e autorizadas recebem
HTTP 410 com o DTO `unavailable` da propria versao, depois dos mesmos guards
de auth, capability, origem, metodo, tamanho e validacao, sem banco. Migrations
D1 administrativas tambem deixam de executar em local/preview; o status usa
somente PostgreSQL. Nao ha fallback D1 quando falta configuracao PostgreSQL.

O runtime D1, seis migrations D1 e testes exclusivamente legados passam para
`Aprendizados/RUNTIME-D1-RETIRADO-1079`, fora de imports, build e execucao de
testes atuais. A fachada PostgreSQL perde o protocolo prepare/bind/exec/batch,
o tradutor SQL e a inferencia de parametros JSON por contexto. Portas nativas,
JSON explicito, CAS, mesma transacao fisica, isolamento, locks, diagnosticos e
normalizacao de saida permanecem. O binding legado pode ser reconhecido como
entrada rejeitada, nunca consultado.

Workspace V2, Performance V2-V6 aditivo, Boletins V2/PDF, Relatorios V2,
Conselho V3 e importacao V9/V10/V11 permanecem. Sem DDL/DML remoto, schema,
ACL/RLS, infraestrutura ou mudanca academica. Aceite exige testes direcionados
e de mutacao, revisao independente, CI/gates do head final, merge commit e
deploy oficial. Detalhes em [retirada #1079](LEGACY_RUNTIME_RETIREMENT_1079.md).

## BN-DEC-042 — Instrumento em branco é "não fez"; todo resultado é final

**Data:** 2026-10-08. **Origem:** determinação explícita do responsável na conversa de 08/10/2026, com alcance "sistema inteiro". Substitui, no motor simplificado, a regra de cobertura que tornava incompleto o trimestre com instrumento exigido em branco, e a exclusão dos resultados parciais dos indicadores. Substitui também a decisão 12 da especificação do fechamento no Portal apenas quanto à exigência de cobertura completa do cálculo.

Um instrumento exigido sem nota lançada é lido como atividade ou avaliação que o aluno não fez. O resultado do trimestre é a soma do que foi lançado e é final como está; `coverage.complete` passa a ser sempre verdadeiro. `missingSlots` e `reasons` continuam listando o que ficou em branco e são a origem do marcador "Parcial" e do `*` nas telas e no PDF.

Consequências aceitas pelo responsável:

- Desempenho: resultados parciais entram em médias, trajetória, comparação entre trimestres, dimensões, participação e atenção recorrente. Um período sem lançamento algum vale zero, e o painel se corrige à medida que as notas entram.
- Resultado anual e recuperação: são calculados o ano todo; aluno com trimestre em branco entra na população de recuperação.
- Boletins: a nota calculada do trimestre é sempre emitida; o motivo `incomplete-calculation` deixa de existir. Demais bloqueios (AM oficial ausente, ano em andamento, recuperação pendente) permanecem.
- Portal do Aluno: a edição aprovada usa a mesma cobertura; a autoridade final continua exigindo concordância com AM/U da fonte.
- Conselho: a elegibilidade segue o resultado anual calculado.

Não muda: zero digitado continua zero; AM/U importadas não são sobrescritas; snapshots e boletins já emitidos não são reinterpretados; as leituras por instrumento (lente Avaliações e atividades para revisar) continuam considerando apenas notas lançadas.

Participação segue a mesma leitura: instrumento de participação com máximo conhecido e sem nota mantém seu máximo no denominador e soma zero; instrumento sem máximo conhecido continua fora. A variação entre trimestres não exige mais preenchimento completo.

A comparação com a AM importada vale para todo resultado calculado, inclusive o marcado como parcial; sem AM importada continua indisponível.

Contrato: nenhum campo de transporte foi acrescentado ou removido. O resumo de `performance-analytics-v6` mantém a invariante anterior (`complete + partial + missing + unavailable = readings`): todo resultado é contado em `complete` e `partial` passa a ser zero; o marcador de instrumento em branco é lido do estado de cada célula. `relational-performance-v2` admite comparação com a fonte em célula parcial e `performance-analysis-v3` deixa de proibir percentual em leitura parcial fora da lente Resultado. Uma aba aberta antes da publicação valida com o contrato antigo e pode mostrar a leitura como indisponível nessas duas situações até ser recarregada. Isso não é retrocompatibilidade: é risco operacional aceito pelo responsável em 08/10/2026 ("Aceito recarregar abas antigas", registrado na PR #1263). Não há recarregamento forçado, para não descartar rascunhos.

## BN-DEC-043 - Retirada da aba Relatórios e dos contratos institucionais V1/V2

**Data:** 2026-10-10. **Origem:** pedido explícito do responsável para excluir a aba Relatórios e todo código exclusivo, preservando consumidores; contrato [#1271](https://github.com/mcpmieda/ecossistema-escola/issues/1271), PR #1270. Em 10/10/2026, 21:04 UTC, o responsável autorizou os ajustes de revisão na mesma PR e o merge depois dos testes: "Sim. Depois merge".

**Substitui BN-DEC-041 exclusivamente quanto a Relatórios:** Relatórios V2 deixa de permanecer e os contratos/serviços institucionais V1/V2 são retirados, junto com a aba `area=reports`, seu cliente e recursos exclusivos. O DTO versionado `unavailable` deixa de ser exigido para o transporte retirado de Reports V1; nenhuma outra retirada ou versão da BN-DEC-041 muda.

`POST /api/gradebook/reports` permanece somente como tombstone: origem oficial, método, autenticação e capacidade `gradebook.persistence.admin` são exigidos; requisição autorizada recebe HTTP 410 `{ state: 'retired' }` com no-store. Não interpreta o corpo, acessa banco/bindings ou depende de limiter externo. Essa exceção é deliberada e restrita ao tombstone; guards/limiters das operações vigentes permanecem. URLs antigas da aba são normalizadas para Importação sem nova entrada no histórico.

Desempenho/PDF docente, Boletins/snapshots, Conselho V3, Importação, Auditoria Atual e seus contratos/serviços compartilhados permanecem. O ensaio de recuperação exercita o GET vigente de `import-diagnostics` no PostgreSQL descartável, aceitando um conjunto recuperado legitimamente vazio; não restaura o adapter exclusivo de Reports.

Sem alteração acadêmica, DDL/DML produtivo, exclusão de migrations aplicadas, backups/histórico, contas, credenciais ou infraestrutura. A PR #1268 e a proposta #1269 ficam fora do escopo. CI/gates no head final, merge commit normal e checks oficiais pós-merge continuam obrigatórios; integração/publicação não comprovam validação real autenticada. Inventário e limites em [REPORTS_RETIREMENT_20261010.md](REPORTS_RETIREMENT_20261010.md); SHAs e resultados efetivos são registrados na #1271 e na PR #1270.

## BN-DEC-044 - Conciliação de alunos com o relatório do Smecel, nascimento canônico e nome configurável

**Data:** 2026-10-11. **Origem:** decisões do responsável registradas na [#1269](https://github.com/mcpmieda/ecossistema-escola/issues/1269) (quatro rodadas de 10/10/2026 e complementos 1, 2, C3 e C4 aprovados em 11/10/2026); contrato [#1276](https://github.com/mcpmieda/ecossistema-escola/issues/1276), PR #1277, com as correções de auditoria pedidas pelo responsável em 11/10/2026. Vale para a primeira entrega; a frequência é entrega posterior e consome este núcleo. Esta decisão não aplica migration, não integra nem publica: a liberação segue o roteiro de [RECONCILIATION_V1.md](../student-identity/RECONCILIATION_V1.md).

**Identidade.** O identificador do aluno continua sendo o `studentUid` existente. Nome, nascimento, Filiação 1, INEP e hash da matrícula são evidências e podem mudar; nenhum deles é chave e nenhum hash de atributos vira identidade. A conciliação é central (`server/student-identity/reconciliation/`) e serve a todo o Ecossistema; nenhum consumidor mantém pareamento próprio. Conciliar não cria conta, não une contas, fotos, senhas, QR, sessões ou permissões e não funde dois `studentUid`.

**Regras.** Com a turma ligada explicitamente pelo operador, associam sozinhas: nome igual na turma, um de cada lado; INEP e nascimento iguais; nome, nascimento e Filiação 1 iguais com INEP diferente. Nascimento divergente, homônimos, candidatos de identidades distintas e associação rejeitada ou desfeita pedem decisão humana e têm prioridade sobre as regras automáticas. Uma origem já ligada e sem revisão aberta conserva seu vínculo nas reimportações; parente com mesmo nascimento e filiação, ou rejeição registrada para outro par, não o reabre. Várias matrículas do relatório podem apontar para o mesmo aluno. Toda associação pode ser separada, e a separação não é refeita sem nova autorização.

**Relatório.** Somente a allowlist é lida e guardada: nome, nascimento, Filiação 1, INEP, hash da matrícula, turma, turno, etapa, situação, data da matrícula e data da transferência. Multifuncional, AEE e Atividade Complementar são descartados. Nascimento ausente, inválido ou futuro em linha elegível rejeita o relatório inteiro antes de qualquer gravação. Relatório recebido antes da Relação fica em pendência por 30 dias, sem criar aluno, UID, conta ou acesso.

**Nascimento.** O nascimento do relatório é o canônico e o PIN usa o ano. **Substitui o cadastro manual do ano de nascimento na aba Alunos:** tela, salvamento e comandos `birth-write`/`birth-batch` deixam de gravar. Nascimento e PIN dependente são atualizados na mesma transação. Quem já tem PIN conserva o acesso pelo dado anterior até ser conciliado; aluno que não está no relatório não recebe novo acesso ao Portal. `account_access_data` permanece somente como leitura de transição; sua retirada física exige decisão e migration próprias.

**Nome.** Uma configuração única escolhe Relação ou Relatório como fonte do nome adotado, com padrão Relatório e uso da outra fonte quando a escolhida não tem o aluno. Vale para Alunos, Portal, Desempenho, Conselho e novos Boletins por `gradebook.student_presentation_v1`. Boletins emitidos seguem seus snapshots. A fonte do nome não participa da comparação de identidade nem altera cálculo acadêmico, notas, AM/U ou posições da Relação.

**Relação.** Um par único de `FOI PARA`/`ESTAVA NO` entre duas turmas, com grafia diferente, é ligado com aviso quando não há conflito ou rejeição. Mais de um par sem correspondência exige escolha explícita, sem pré-seleção, exibindo as grafias originais, turmas, posições e direções. A prévia e o cancelamento não gravam; o servidor vincula a conferência ao ator, ao arquivo e à geração/revisão da base, revalidando todas as pontas sob o lock anual antes da aplicação integral, inclusive dos registros independentes. Esta redação corrige a exigência de alterar a planilha e corresponde à seção 8 da #1269. Evidência de outra pessoa na mesma posição recusa o reuso. **Substitui o reparo automático de identidade dividida do importador V9:** nem a escolha explícita autoriza fundir cadastros existentes, contornar rejeições ou mover notas, fechamentos, Conselho, contas ou fotos entre identidades.

Sem alteração de regra acadêmica, de migrations já aplicadas ou de `PROJECT_STATE.yaml`. Múltiplos anos, fusão de identidades, episódios de matrícula e frequência ficam fora desta decisão.

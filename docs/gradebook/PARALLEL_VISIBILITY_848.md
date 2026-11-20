# Visibilidade e cobertura da PARA — #848 / BN-DEC-034, complementada pela #850

Pedido inicial: 18/09/2026, 00:45 UTC. Base da #848: `main@1e29b008501e54e63f54b6c8021d6b027a85466c`. A **BN-DEC-035/#850** retifica a composição aditiva da #844 e determina a única exceção: nota numérica de PARA lançada pelo professor aparece e participa da comparação mesmo sem elegibilidade normal. A regra vigente está em [PARALLEL_QUANTITATIVE_850.md](PARALLEL_QUANTITATIVE_850.md). Mantém-se a orientação de interface da #846.

## Comportamento

| Elegibilidade normal | Fato da PARA | Lista individual | Cobertura da PARA existente |
| --- | --- | --- | --- |
| Elegível | Valor positivo | Mostra nota | Resolvida |
| Elegível | Zero numérico | Tirou zero | Resolvida |
| Elegível | NULL observado | Não fez | Pendente |
| Elegível | Sem observação | Ausência de lançamento, sem inventar Não fez | Pendente |
| Não elegível | Sem nota numérica | Não mostra a linha | Fora dos instrumentos exigíveis |
| Não elegível | Nota numérica, inclusive zero | Mostra nota ou Tirou zero | Resolvida pela exceção registrada |
| Sem definição da PARA | Nenhum instrumento | Não inventa linha | Não inventa obrigação |

A decisão usa somente `parallelApplicable` calculado pelo núcleo: elegibilidade normal OU nota numérica registrada. Os dois limites estritos de 60%, a avaliação anterior à PARA e o arredondamento não mudam. A composição foi retificada: quantitativo original Q=AV1+AV2; considerado=max(Q,P); bruto=considerado+qualitativo. Mostrar uma nota não significa que houve ganho: P igual ou inferior a Q resolve o lançamento, mas não modifica Q.

A elegibilidade continua independente das notas ausentes nas duas avaliações. Cobertura é outra informação: uma PARA **existente e efetivamente aplicável** entra em `requiredSlots`; qualquer número, inclusive zero, entra em `resolvedSlots`; null permanece em `missingSlots` apenas quando normalmente elegível. A exceção numérica já está resolvida. O asterisco some por causa da PARA somente quando essa pendência é resolvida ou dispensada. Uma AV/atividade ainda ausente continua mantendo o resultado parcial. Um período inteiramente sem valor permanece sem resultado numérico; PARA zero realmente registrada é um valor, não ausência.

## Consumidores

| Caminho | Efeito |
| --- | --- |
| `resolveSimplifiedTermV1` | Única decisão de elegibilidade, exceção, pontos e cobertura exigível. |
| `performanceCellV2` | Herda completo/parcial e comparação; matriz, trajetória, anual, Conselho e Relatórios recebem o mesmo estado. Não há estrela decidida no browser. |
| `PerformanceStudentDetailV2` | Usa showParallel do núcleo, que inclui a exceção numérica; mantém os estados granulares existentes, sem reintroduzir OR locais. |
| `performance-analysis-v3.ts` | Quantitativo considerado consulta os slots exigíveis; não duplica máximo nem pontos da PARA. Avaliações deixam neutras as células dispensadas sem nota; colunas consideram também as exceções numéricas do recorte. |
| `performance-analytics-v6.ts` | Cobertura inclui PARA efetivamente aplicável. Resumos são omitidos somente sem elegíveis nem notas excepcionais no recorte. Estados, comparabilidade e parciais por estudante/docente seguem a matriz central. |
| `AcademicStudentReaderPostgresV1.projectPreparedSourceV2` | Filtra as parciais da mesma edição aprovada pela aplicabilidade efetiva, preservando zero, observado/null e AM/U oficial. REC e autoridade conservam a completude regular preexistente da edição oficial pelo adaptador privado `officialEditionTermV1`. |
| `scopedSelfV2` → `StudentGradesV1` | O fluxo já projeta a edição aprovada em cada leitura; a tabela recebe a lista filtrada e usa os rótulos granulares existentes. Sem busca de notas atuais, nova publicação ou nova fórmula no React. Desde 27/09/2026 a tela do aluno é `StudentPortalWorkspaceV1` (a tabela foi removida); o teste da #848 abre a disciplina nela. |

Em matriz de avaliações, a coluna comum existe quando há elegíveis ou notas excepcionais no recorte. Só as células sem elegibilidade e sem nota ficam neutras. A operação não apaga fatos armazenados nem o histórico de importação.

## Autoridade e publicação

A AM/U importada continua sendo o resultado oficial do Portal. Não foi acrescentado asterisco derivado localmente ao total oficial do Portal, nem campo HTTP novo; os indicadores existentes de cobertura no Banco e seus consumidores usam o núcleo. REC final, N/C, R/R e decisões humanas preservam suas fórmulas/estados; resultados descritivos correntes que dependem de completude recebem a cobertura corrigida.

O Portal não usa uma nota recém-importada para decidir a visibilidade de uma edição antiga com autoUpdate desligado. `scopedSelfV2` fornece a edição aprovada ao mesmo reader, e o filtro opera somente nos fatos dessa edição. Parciais, calendário, acesso e liberação de períodos continuam sendo limites independentes. Sem evidência estruturada de uma edição legada, não reconstruir elegibilidade usando notas atuais: conservar a semântica histórica e registrar a limitação.

A revisão da #848 identificou que aplicar a nova pendência da PARA diretamente à recuperação/autoridade do reader poderia remover REC e a classificação de uma edição já aprovada. A fronteira oficial mantém duas visões dos mesmos termos: a saída corrente intacta determina a visibilidade de PARA; uma cópia de cobertura sem slot 3 conserva exclusivamente a completude regular usada anteriormente por REC e `sourceAgrees`. O adaptador não calcula notas, não muda máximos/arredondamento/elegibilidade, não apaga outras pendências e não torna completo o resultado descritivo do Banco. Todos os números e as máscaras REC/N/C/R/R continuam vindo dos mesmos fatos e do mesmo motor. A PR #1122 retira a cópia legada por aluno: o Portal usa a edição preparada V2, sem fallback para notas atuais ou projeção anterior. A migração física 0019 permanece pendente e exige deploy do Worker antes de sua aplicação.

Conferência produtiva estritamente agregada e somente leitura da #848 constatou publicação por escopo ativa e nenhuma publicação legada com revisão sem edição preparada. Isso não é prova visual da sessão de cada estudante nem uma nova auditoria produtiva da #850. Nenhum DML/DDL, backfill, reimportação, alteração de fonte ou republicação forçada foi executado naquela conferência.

## Regressões e gates

Os testes usam exclusivamente fatos e identidades sintéticos, com expectativas atualizadas à BN-DEC-035:

- `performance/parallel-visibility-848.test.ts`: três trimestres, limites, ausência, zero, exceção, cobertura/asteriscos, anual, dimensões, estatísticas e colunas de recorte misto/filtrado.
- `performance/parallel-visibility-848-sql.test.ts`: leitores PostgreSQL/PGlite reais com migrations canônicas, seis instruções por matriz/detalhe/análise, estado/granularidade e nota excepcional preservada.
- `performance/parallel-visibility-848-ui.test.tsx`: componentes reais Banco/Portal, Não fez/Tirou zero, linha oculta ou excepcional, atualização do mesmo recorte e asterisco vindo do núcleo; nenhum comentário de arredondamento reintroduzido.
- `student-portal/academic/parallel-visibility-848.test.ts`: edição preparada, imutabilidade, nenhuma consulta atual, versão divergente recusada, AM/U preservadas e limites de acesso/calendário/parciais.
- `student-portal/academic/approved-recovery-848.test.ts`: reader real preserva REC numérica, N/C, R/R, pendência REC e autoridade sem resolver a PARA corrente; faltas regulares continuam bloqueando. Exercita `scopedSelfV2` com linhas de edição selecionadas sintéticas, autoUpdate desligado, revisão antiga e sem projeção anterior. Autorização e seleção SQL também continuam cobertas por seus gates de integração existentes.

Expectativas anteriores que descreviam a regra substituída são atualizadas somente com cenários explícitos. Não remover testes, afrouxar limites, forjar completude ou pular validação. Revisão do diff, HEAD, resultado de `npm run verify`, gate PostgreSQL/isolamento e publicação efetiva devem constar na issue/PR. Acesso local ao clone falhou por DNS; execução completa é comprovada pelo CI oficial, não alegada como local. Smoke visual autenticado é evidência separada.

O responsável autorizou ajuda do CodeRabbit exclusivamente na #848 em 18/09/2026, 01:44 UTC, e novamente com escopo próprio na #850 às 09:57 UTC. Isso não autoriza configuração permanente, outros agentes, mudança de dependências/workflows ou ações produtivas fora de cada pedido. As contribuições são conferidas diretamente antes da integração. Os avisos do ambiente isolado do revisor não substituem os checks do projeto instalado pelo lockfile.

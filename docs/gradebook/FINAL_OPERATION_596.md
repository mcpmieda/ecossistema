# Operação institucional final — #596

Data da consolidação: 11/09/2026 (America/Sao_Paulo).

## Baseline factual

- `main@80b2916185fc6a49df7c5ab0af71e2be4dcdeb66`;
- CI da FINAL-4 `34667519751` e deploy oficial `34667699446` aprovados;
- `npm run verify`: 184 arquivos aprovados, 1 ignorado; 1.439 testes aprovados, 3 ignorados; build aprovado;
- FINAL-1 #633, FINAL-2 #634, FINAL-3 #635, FINAL-4 #406 e aceite acadêmico #347 encerrados;
- `imported-source` é a autoridade dos consumidores atuais; `native-engine` continua somente descritivo.

O ano oficial em operação é 2026. O ano 2025 foi materializado a partir de arquivos descartáveis de teste para validar o ciclo completo; não representa dado acadêmico oficial. O seletor global isola o contexto anual, inclusive identidade de aluno, e não existe comparação entre anos.

## Responsabilidades

- **Operação escolar:** selecionar o ano global, importar primeiro a Relação e depois as fontes de notas, conferir diagnósticos e emitir artefatos somente no recorte correto.
- **Autoridade acadêmica:** validar AM/U e situações da Relação, conduzir Conselho, registrar somente votos favoráveis/contrários e tomar eventual desempate do diretor fora do sistema. Desde 23/11/2026 (BN-DEC-049, #1558) o registro de decisão e de votos está em refação.
- **Manutenção técnica:** integrar apenas heads verdes, acompanhar o deploy oficial, executar smoke autenticado e preservar logs/evidências sem dados identificáveis.

## Jornada normal

1. Confirmar usuário autorizado, ano letivo global e turma antes de qualquer ação.
2. Em ano novo, importar a Relação antes das fontes de notas; a importação materializa o ano automaticamente.
3. Reimportar arquivo idêntico somente quando necessário: o resultado esperado é “sem mudanças acadêmicas”.
4. Conferir Auditoria e a Relação importada antes de interpretar Desempenho, boletins ou relatórios. A interface Centrais foi retirada por solicitação do responsável em 09/10/2026; o cadastro mestre permanece.
5. Usar Desempenho para leitura e comparação entre trimestres do mesmo ano; ele não substitui a fonte oficial.
6. No fechamento anual, tratar R/R em qualquer componente como reprovação automática e fora do Conselho. Desde 23/11/2026 (BN-DEC-049) o aluno com R/R ou N/C na planilha aparece no Conselho só para conhecimento, sem deliberação.
7. No Conselho, registrar decisão humana e votos favoráveis/contrários; empate e voto de minerva permanecem externos. Desde 23/11/2026 (BN-DEC-049, #1558) a reunião só abre e o registro de decisão e de votos está em refação; ver [RELATIONAL_COUNCIL_V3.md](RELATIONAL_COUNCIL_V3.md).
8. Emitir boletim, lote, PDF e relatórios somente após conferir ano, período e turma. Reimpressão usa o snapshot histórico, sem reler notas atuais.

## Monitoramento mínimo

- workflow de validação do PR e deploy Cloudflare Pages verdes no SHA esperado;
- login/capability, origem oficial e respostas `no-store` preservados;
- aplicação autenticada abre Importação, Auditoria, Desempenho, Boletins, Relatórios, Conselho e Configurações; favoritos antigos de Centrais retornam à Importação;
- PostgreSQL permanece saudável, sem drift de migration, órfãos ou duplicidades lógicas;
- falhas de importação, conflitos de revisão, aumentos anormais de latência/payload e achados de segurança são tratados como alerta, não como vazio acadêmico.

O checkpoint de 11/09/2026 mediu 28 MB no banco e 17 MB no schema `gradebook`, projeto saudável e Advisor sem findings. É uma fotografia operacional, não SLA nem garantia futura.

## Incidente e interrupção segura

1. Interromper importações, emissões e decisões do recorte afetado diante de escrita parcial, divergência material, perda de histórico, schema inesperado, exposição de dado ou autoridade ambígua.
2. Registrar de forma sanitizada horário, ano, área, SHA publicado e ação que falhou; preservar os arquivos-fonte sem modificá-los.
3. Confirmar CI/deploy, autenticação, origem, provider PostgreSQL e estado atual antes de repetir uma escrita.
4. Usar Auditoria e consultas somente leitura para delimitar o problema. Não corrigir diretamente nota, situação, voto ou resultado por SQL.
5. Repetir apenas operações idempotentes e com a mesma expectativa de revisão. Conflito CAS exige recarregar o estado; não se remove a proteção.
6. Reverter código significa publicar um commit anterior validado; isso não desfaz nem restaura dados PostgreSQL.
7. O D1 histórico não contém as escritas novas e não é rollback válido do estado atual. Qualquer reconciliação ou restauração de dados exige procedimento e autorização próprios.

## Recuperação e limite aceito

A #662 comprovou restauração lógica e contenção em PostgreSQL local descartável, incluindo catálogo, dados, sequences, ACLs e jornadas selecionadas. Essa prova reduz risco técnico, mas não cria backup externo, retenção, RPO ou RTO.

O responsável adiou explicitamente backup/restore gerenciado e aceitou operar por enquanto sem essa garantia. Portanto, perda destrutiva do banco pode não ser recuperável no ponto desejado. Essa lacuna permanece visível e deve ser reaberta antes de prometer continuidade institucional ou definir RPO/RTO.

## Evidência de aceite

- [piloto integral e matriz sanitizada](FINAL4_PILOT_406.md);
- [readiness consolidada](PRODUCTION_READINESS.md);
- [ensaio de recuperação local](RELATIONAL_RECOVERY_REHEARSAL_662.md);
- [decisões vigentes](DECISIONS.md);
- [matriz técnica](TEST_MATRIX.md).

Com o risco de backup explicitamente aceito e adiado, não há bloqueador funcional conhecido para a operação atual. Mudança de schema, regra acadêmica, autoridade, infraestrutura, segredo ou permissão continua exigindo decisão própria.

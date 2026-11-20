# Configurações e reset anual — #688

## Resultado funcional

A área Configurações usa o mesmo shell e o mesmo ano global do Banco de Notas. `Resetar o sistema` limpa um único ano materializado e deixa o produto pronto para que a Relação desse ano seja importada novamente. O reset não cria ano, não compara anos, não reinicia IDs e não modifica a planilha original.

`vinculo.situacao = NULL` continua sendo o estado relacional regular. Na matriz de Desempenho ele aparece como `Em curso`; nenhum valor novo é escrito no banco.

## Protocolo de segurança

1. `preview` abre uma transação protegida pelos locks anuais e conta os registros acadêmicos atribuíveis ao ano nas 30 relações do Gradebook; a coordenação técnica do Portal participa da revisão, mas não altera o formato público das contagens V1.
2. O servidor deriva uma revisão SHA-256 do contrato, ano e contagens e devolve a frase exata `RESETAR <ano>`.
3. A interface exige a frase e uma confirmação separada de irreversibilidade.
4. `execute` abre transação `SERIALIZABLE`, bloqueia as 30 relações contra escrita concorrente, refaz a prévia e rejeita qualquer revisão divergente.
5. As exclusões seguem a ordem das FKs. Depois dos dados acadêmicos, a conclusão privada remove `revision_event`, todas as provas `year_reset_preview_proof` e `academic_revision` do mesmo ano. O serviço confere as pós-condições antes do commit.
6. Qualquer exceção reverte a transação. O retorno/log operacional registra somente ano e contagem, sem nomes, notas, hashes ou payloads.

Diagnósticos com `ano IS NULL` ficam preservados, pois não existe evidência segura para atribuí-los ao ano escolhido. Sequências também ficam: uma nova importação recebe IDs novos e não recicla identidade antiga.

## Escopo apagado

- configuração do ano, alunos, turmas, professores e disciplinas;
- vínculos, ofertas, instrumentos, notas e fechamentos;
- importações, diagnósticos atuais e trilha humana;
- decisões legadas, sessões, votos, comandos, fechamentos e fotografias do Conselho;
- todos os históricos alcançáveis por ano/aluno/turma/oferta/instrumento/importação;
- eventos de revisão técnica, provas de reset e coordenação `academic_revision` atribuíveis ao ano apagado.

O próprio `ano_letivo` é removido no fim. Por isso o bootstrap deixa de oferecê-lo imediatamente e a Relação é o único caminho para materializá-lo outra vez.

## HTTP, permissões e limites

`POST /api/gradebook/year-reset` exige origem oficial, sessão autenticada, `gradebook.persistence.admin`, PostgreSQL selecionado, gate produtivo e `Cache-Control: no-store`. O body máximo é 2 KiB e os schemas são estritos.

As tabelas centrais já admitiam `DELETE` pela role backend. A `0008_year_reset_acl_v1.sql` acrescenta somente esse verbo às dez relações criadas depois com ACL append-only. Nenhuma role de navegador recebe `USAGE` ou privilégio de tabela. A migration não executa DML nem modifica schema, sequência ou regra acadêmica.

## Evidência e limite operacional

Os testes PostgreSQL descartáveis sem PII semeiam dois anos e todas as 30 relações. Eles demonstram prévia, conflito por mudança, rollback depois de falha injetada, exclusão integral de um ano, preservação exata do outro e nova materialização posterior.

Não existe backup gerenciado/RPO/RTO contratado. A UI declara essa limitação. Deploy e smoke não executam o botão final em produção; uma exclusão real só ocorre depois da confirmação explícita do operador na própria tela.

## Extensão contratada #703 — implementação G #706

A descrição acima é o runtime #688. Seu hash de contagens **não detecta alteração de conteúdo com as mesmas contagens**. A #703 acrescenta schemas/comparação pura e congela o protocolo abaixo; não afirma corrigir o serviço ativo dentro de uma allowlist de contratos. G implementa protocolo/token/HTTP e S cobre produtores antes de habilitar vínculos. D/H testam FKs e contenção em PostgreSQL real, não por simulação de promises.

### Bloqueio e compatibilidade

Preview e execute, já autorizados por `gradebook.persistence.admin`, consultam o guard na mesma transação. Qualquer vínculo Portal do ano bloqueia, incluindo conta bloqueada, inativa, pendente, sem sessão, sem publicação ou aluno em saída. Nenhum filtro de elegibilidade/estado/ano 2026 deve esconder vínculo legado de outro ano. Schema/adapter indisponível retorna `unavailable`, nunca zero. A extensão aditiva retorna exatamente `{contractVersion:1,state:'portal-linked-accounts'}`, sem nomes, IDs ou lista. G mapeará HTTP 409 e atualizará a mensagem/retenção da prévia na UI existente; até lá, cliente V1 aceita o novo estado e a UI mostra erro genérico. Um cliente anterior com enum fechado falha como indisponível. Todos os pedidos e retornos antigos continuam válidos; nenhum serviço emite o estado novo nesta entrega.

Desvinculação é comando Portal separado com escopo/versão/contagem esperada, auditoria e confirmação explícita. Revoga sessões/desafios/credenciais e remove a referência acadêmica viva atomicamente, preservando conta e histórico com referência histórica sem FK destrutiva. `closedAt` sozinho com FK preenchida continua bloqueando. Não usar CASCADE/SET NULL silencioso no reset. Nova prévia é obrigatória após encerrar; importação posterior não religa por nome e retorno de situação não desfaz encerramento. D define FK restritiva e unicidade viva. Contas, credenciais, sessões e histórico de identidade Portal continuam fora da exclusão BN; somente o estado técnico anual de revisão/prova/coordenação é eliminado pela #870.

### Ordem de locks revisada por CODEX

**Delta #782 / PA-DEC-008 (14/09/2026):** a exclusividade anual descrita abaixo permanece para escritores, preview/execute de reset e comandos administrativos. Autenticação individual, sessão própria/Self e jobs/reconciliação Portal passam a global compartilhado → ano compartilhado → coordenação `FOR SHARE` → contas exclusivas ordenadas → credenciais/sessões/jobs. Não alteram fatos acadêmicos, vínculos ou coordenação. O escritor exclusivo anual conflita com esses leitores; reset global exclusivo também os exclui. A ordem e a mesma conexão até commit/rollback permanecem. Nunca promover uma transação compartilhada para escritora; o adapter rejeita esse uso. Nenhuma alteração do SQL/DDL ou da autoridade dos produtores BN é necessária. Evidência nativa e publicação são registradas na #782; a regra anterior permanece como histórico do protocolo #703.

Os locks das 30 tabelas são globais mesmo quando o DELETE filtra um ano. Portanto, somente `(613,ano)` não coordena reset com escritores de outros anos. Reservar `(613,0)` como barreira global: writers usam `pg_advisory_xact_lock_shared(613,0)`; execute reset usa `pg_advisory_xact_lock(613,0)`. Zero está fora do intervalo de anos BN. Todas as aquisições são transacionais, na mesma conexão, até commit/rollback.

1. Antes de qualquer leitura bloqueante/escrita/FK: barreira global (compartilhada para escritores e preview; exclusiva para reset). Nunca promover shared para exclusive na mesma transação.
2. Advisory `(613,ano)` exclusivo; se mais de um ano, ordem crescente. Preservar o lock V9/V10 existente, mas movê-lo para depois da barreira. O contexto externo adquire uma vez; wrappers aninhados reutilizam, sem abrir outra conexão.
3. Reset: 30 locks `SHARE ROW EXCLUSIVE` na ordem determinística de `RESET_TABLES_V1`, antes de contas. Demais writers não adquirem esses locks explícitos. A barreira impede writer de outro ano segurar tabela enquanto espera recurso do reset.
4. Ler/bloquear coordenação persistente do ano, depois contas por UUID ordenado, depois credenciais/sessões/jobs. Toda transação Portal que toca vínculo/BN obedece a mesma ordem, inclusive fechamento e autenticação que bloqueie conta e consulte BN. Não adquirir lock acadêmico após conta.
5. Guard e comparação da prévia dentro dos locks; exclusões atuais na ordem de FKs; consumir a prova, concluir a remoção acadêmica e então apagar eventos/provas/coordenação do ano na mesma transação. Se algum passo falha, rollback integral.

Snapshot merece cuidado: um SELECT de advisory pode estabelecer snapshot antes de esperar. Preview contratada usa READ COMMITTED, faz todas as leituras depois dos locks e persiste somente a prova técnica (sem mutação acadêmica); o advisory anual impede mudanças do ano durante essas leituras. Execute preserva SERIALIZABLE, mas depois dos locks faz `SELECT ... FOR UPDATE` na linha durável de coordenação anual. **Todo** produtor relevante atualiza essa linha: se houve commit durante a espera, PostgreSQL aborta o snapshot antigo; repetir a transação inteira com limite, nunca continuar com dados antigos. A linha existe enquanto o ano está materializado e é apagada somente depois que a execução do reset comprova a remoção do ano; uma nova Relação recria a coordenação antes das novas escritas. Ausência inesperada enquanto o ano existe = indisponível. Não resolver snapshot antigo repetindo SELECT dentro do mesmo REPEATABLE READ/SERIALIZABLE.

Revisão de projeto fundamentada na [documentação de locks PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html) e [isolamento transacional](https://www.postgresql.org/docs/current/transaction-iso.html): locks de tabela conflitam com escritores, ordem consistente reduz deadlocks e snapshots serializáveis exigem retry após conflito. Esta ordem é uma decisão do projeto, não prova de execução. G/S/H precisam ensaiar dois clientes, mesma/ outra safra, vínculo durante espera, fechamento durante reset, flush V11, deadlock/timeout/40001 e falha injetada. Definir lock_timeout/statement_timeout limitados e retry idempotente; nunca repetir reset consumido como nova operação.

### Prévia ligada ao estado, operador e janela

`previewRevision` mantém 64 hex no transporte, mas G substitui o hash público de contagens por token aleatório de 256 bits. Guardar apenas SHA-256 do token numa prova técnica durável, com operação `execute`, ano, digest do ator autenticado, `issuedAt`, `expiresAt` (máximo 5 minutos), consumo e três versões: `academicRevision`, `resetRevision` e `portalLinkRevision`. A prova/coordenação permanecem fora das contagens públicas V1, mas deixam de sobreviver ao reset concluído: a #870 remove todas as provas do ano e a coordenação depois de validar o token consumido na mesma transação. `resetRevision` cobre qualquer escrita efetiva nas relações atribuíveis ao ano, inclusive diagnóstico/histórico/snapshot sem efeito acadêmico. `portalLinkRevision` muda também se criar e encerrar deixar a contagem final igual. Bootstrap sem versão confiável bloqueia.

Execute autentica novamente, busca a prova pelo digest do token fornecido, verifica operação/ano/ator/janela/consumo e compara todas as versões atuais sob locks. Token inexistente/expirado/usado/estado diferente resulta `preview-changed`; vínculo existente prevalece como `portal-linked-accounts`. Frase e confirmação forte continuam obrigatórias. Consumir prova por CAS na transação do DELETE; não confiar em prova enviada pelo browser nem em relógio do cliente. Tokens, digests e payloads de prova não entram em logs. A função `yearResetPreviewIsCurrentV1` cobre somente comparação do registro já autenticado, não aleatoriedade, persistência, digest, autorização ou CAS.

### Gate e handoff

G-C autoriza consumidores após #702/#703 integradas e testes de contrato/revisão verdes. Não libera DDL, vínculos ou reset sem G/S/H: G precisa aceitar os hooks auxiliares de diagnóstico/snapshot com ajuste explícito de sua allowlist; S não pode ativar publicação enquanto houver produtor sem revisão. I recebe o delta para `PROJECT_STATE.yaml`, que permanece sob sua propriedade. Nenhuma migration, SQL produtivo, recurso, secret, DNS ou UI foi alterado pela #703.

## Delta #870 — limpeza técnica integral do ano

A auditoria produtiva de 18/09/2026 encontrou, após a remoção dos fatos acadêmicos de 2025, diagnósticos e revisões técnicas ainda atribuíveis ao ano. A regra vigente passa a ser: um reset anual concluído não conserva `revision_event`, `year_reset_preview_proof` nem `academic_revision` do ano removido. Além disso, uma fotografia de Auditoria com ano explícito só pode persistir se `gradebook.ano_letivo` estiver materializado sob o lock anual; planilha antiga de ano já removido vira no-op e não recria coordenação. Na primeira Relação legítima, o cliente repete a Auditoria depois da persistência confirmada, quando o ano já existe. O contrato HTTP V1 e `deletedRows` permanecem compatíveis e continuam descrevendo a exclusão acadêmica; a limpeza técnica é uma pós-condição interna obrigatória. Contas e histórico de identidade Portal não são apagados por essa mudança e vínculos vivos continuam bloqueando o reset.

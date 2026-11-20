# Cobertura e verificação operacional — pacote #839

Inventário de 17/09/2026. Código examinado: main 322730f8 e alterações das PR841/842. Resultados efetivos de CI, SHAs e publicação ficam nas PRs; este documento não declara aprovação antecipada.

## Produtores encontrados

| Origem | Caminho existente | Avisos |
| --- | --- | --- |
| Importação de vínculos/notas | import-relational-service-v9 → recordImportResetWriteV1 após flush na transação | revision_event → admin/gradebook; aluno nas causas acadêmicas previstas |
| Conselho, incluindo votos/justificativa | relational-council-v3 → recordResetWriteV1, causa council | Admin e student/gradebook, inclusive council com affects_academic=false |
| Diagnóstico de importação | import-diagnostics-snapshot-v1, causa diagnostics | Admin/gradebook |
| Tratamento de diagnóstico | import-diagnostic-treatment-v1, causa audit-treatment | Admin/gradebook |
| Nomes de avaliações | assessment-names-v1, causa academic-policy | Admin e student/gradebook |
| Nascimento, contas, QR, bloqueios, revogação, configurações e publicação | Tipos enumerados em audit_event → enqueue_portal_live_event_v1 | Admin e student/portal; destinatários filtrados no servidor |

A migration 0012 limita o trigger acadêmico a 2026. Os quinze tipos do trigger Portal na migration 0011 são: activated, password-reset, account-reset, qr-issued, qr-reprinted, qr-regenerated, blocked, unblocked, session-revoked, birth-changed, settings-changed, published, unpublished, projection-updated e links-closed. Login e login-failed não produzem esse aviso. O trigger filtra tipo, não resultado; por isso o aviso amplo não prova alteração de um campo específico.

O novo live-coverage-839.test.ts exercita oito combinações acadêmicas, quinze tipos de auditoria, replay, exclusão de ruído de login e cursor distinto quando a versão acadêmica não muda. É prova sintética da fronteira evento→outbox, complementar aos testes existentes dos serviços/CAS; não representa uma nova homologação end-to-end de cada botão.

## Consumo e recuperação

O canal administrativo compartilhado da PR842 avisa o scheduler; cada leitor usa seu contexto e uma consulta autorizada. O aluno mantém seu canal próprio com filtragem no servidor. Não são enviados dados acadêmicos pelo socket. Abertura, filtros e retorno continuam sendo motivos para consultar.

Não há cobertura automática para escrita SQL direta que ignore os produtores, anos fora de 2026, simples passagem do relógio ou qualquer evento administrativo arbitrário. Nem todo comando do Banco aciona drain imediato; o cron existente participa da recuperação. Um socket conectado não prova entrega da outbox. Manter fallback e não prometer atualização instantânea ou polling zero.

A redução explícita para 120 segundos permanece somente no Analytics V6 da PR840. As demais áreas mantêm a cadência anterior. A pausa de áreas ocultas conserva telas e rascunhos; não interrompe gravações. Aviso genérico durante edição não substitui a comparação transacional da versão original pelo servidor.

## Medições somente leitura anteriores à publicação do backend

Às 18:27:02 UTC: 185 avisos, todos pendentes, 135 com tentativas, nenhuma entrega confirmada na última hora; nove conexões de cliente para máximo configurado de 60, zero bloqueadas e zero idle in transaction. É um retrato daquele instante, não prova da causa do timeout às 15:54 UTC.

O Performance Advisor às 18:27:29 UTC mostrou 24 chaves estrangeiras sem índice de cobertura e quatro índices não utilizados. Nenhum índice foi criado/removido. Não se deve confundir recomendação estática com necessidade de aplicar todos os índices.

A seleção de 50 eventos pendentes em EXPLAIN ANALYZE, sem FOR UPDATE ou alteração de lease, executou em 0,283ms; planejamento 0,723ms, chave primária, 92 blocos em cache e zero leitura de disco. Isso não mede a transação inteira, fanout, rede ou CPU Cloudflare. Não é evidência para corrigir serialização com um índice.

As estatísticas pg_stat_statements acumulam desde 07/09/2026 09:17:25 BRT. Operações históricas identificadas incluem upsert academic_record_versions (134 chamadas, média 2.918,85ms), capture_publication_source_v2 (136 chamadas, média 969,14ms) e uma consulta ampla de conferência (três chamadas, média 26.825,61ms). Não representam a latência atual de uma tela, não datam a chamada mais lenta e não foram executadas novamente para simular carga. Nenhum valor acadêmico individual foi exportado.

## Pendências que não devem ser confundidas com código concluído

Após deploy oficial, verificar novamente agregados da outbox deixando o cron normal recuperar; não marcar ACK, excluir pendências ou drenar manualmente. Comparação real de requisições/CPU/latência requer métricas Cloudflare não acessíveis pelos conectores pesquisados. Índices/cache continuam condicionais e sem alteração de infraestrutura.

A issue #843 registra a proposta de contrato para diagnóstico sanitizado persistente do frontend. O receptor ainda não foi implementado/aprovado. BN-CARGA/BN-TELA e agregados de backend não são observabilidade completa. Homologação autenticada em dois computadores e aba antiga atravessando deploy permanecem verificações separadas. Não encerrar #839 nem declarar todo o pacote homologado apenas por CI. A causa inicial do incidente continua não comprovada.

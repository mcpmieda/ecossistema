# Operação e integração H → I

## Estado final e responsabilidade — #760

O Portal está publicado e tecnicamente aceito, com abertura escolar geral **não autorizada**. Estado fechado esperado: `populationEnabled=false`, nenhum acesso explicitamente habilitado, nenhuma sessão válida e nenhum período publicado ou pendente. `PORTAL_SERVING_ENABLED=true` mantém o software disponível para operação controlada; não substitui as guardas de população, conta e período.

Responsável institucional: autoriza por escrito calendário, turmas/contas, períodos e distribuição privada. Responsável técnico: executa o menor escopo autorizado, acompanha saúde e conserva rollback. Suporte registra uma issue nova com horário, rota/ação, estado esperado e observado, sem nome, nota, nascimento, QR, PIN, senha, cookie, token, IP ou captura com PII.

### Abertura deliberada futura

1. Confirmar autorização institucional e calendário definitivo; não reutilizar automaticamente datas da massa de teste.
2. Confirmar `healthz=ok`, deploy esperado, filas sem atraso e ausência de lock/statement timeout recorrente.
3. Habilitar somente a população e as contas/turmas autorizadas. Manter os demais escopos fechados.
4. Publicar somente os períodos aprovados e aguardar a projeção correspondente.
5. Distribuir QR por canal privado; nunca por issue, log, captura ou repositório.
6. Exercitar uma conta de verificação: entrada, leitura autorizada, saída e reentrada. Interromper a abertura se houver mistura de identidade, repetição de erro transitório ou redirecionamento indevido.
7. Ampliar somente após a amostra estável. Registrar contagens e tempos agregados, sem identificadores.

### Contenção e rollback operacional

Na ordem mais segura aplicável: impedir novas entradas desligando acesso no escopo afetado; retirar períodos se a visibilidade acadêmica estiver incorreta; revogar sessões; pausar população; usar `PORTAL_SERVING_ENABLED` apenas para manutenção ou incidente amplo. Rollback de código usa o workflow oficial e preserva schema, chaves, revogações, contas e projeções. Não voltar a D1, limpar histórico ou reativar credenciais antigas.

Depois da contenção, confirmar por agregados: acesso habilitado=0 no escopo, sessões válidas=0, períodos ativos=0 quando retirados e população no valor deliberado. Recovery de dados segue o roteiro técnico existente; backup gerenciado/RPO/RTO continua fora da garantia.

### Monitoramento e escalonamento

`/healthz` prova liveness/estado agregado, não login nem integridade acadêmica. Leituras podem repetir 503 de forma limitada. Comandos administrativos fazem no máximo uma repetição de confirmação apenas para resposta ambígua, preservando exatamente corpo, CAS e chave de idempotência; recusas, conflitos, autenticação e rate limit não repetem. Lock timeout/55P03 indica contenção; identificar a operação concorrente antes de considerar capacidade. Não aumentar Hyperdrive, plano ou timeouts sem evidência, medição e autorização específica.

## Logs e auditoria

`metrics-v1.ts` aceita somente operação enumerada, resultado enumerado e contagens/tempos. O emissor recusa campos extras e falha de logging não altera o resultado de um commit. Não passar Error, Request, URL, headers, parâmetros SQL ou DTOs ao logger. Manter invocation logs desativados; URLs podem conter informação sensível. O schema de métricas não aceita identificadores de aluno, nome, notas, nascimento, PIN, senha, QR, cookie, token ou IP.

P-10/P-11 adicionam dois eventos igualmente fechados:
- `student-portal-auth-burst-v1`: somente `allowed | global-limited | subject-limited | invalid-subject | unavailable`; nunca inclui subject, QR, challenge, IP ou hash;
- `student-portal-db-lifecycle-v1` (até 14/11/2026; desde a issue #1426, 22c, os campos vêm em `student-portal-operation-v1`): operação, outcome, `openRoleMs`, `applicationMs` e attempts (1–2). `openRoleMs` cobre a primeira consulta `SELECT current_user` **mais** eventual estabelecimento lazy da conexão postgres.js; não representa custo puro do SQL nem deve ser usado para remover a role check.

Esses eventos servem para volume/correlação. Sem collector/dashboard/threshold externo, log emitido não equivale a alerta operacional.

O IP de rede é metadata, nunca identidade. Pages deve obter o header da requisição original entregue pela Cloudflare antes do binding; o contexto privado transporta esse valor. Em subrequests, ele pode representar o Worker intermediário. Não inferir usuário a partir do endereço, de `x-forwarded-for` ou de claims do body. `withAuditSqlV1` usa SET LOCAL na mesma transação do evento; a máscara é /24 no IPv4 e /48 no IPv6. Sistemas sem requisição têm IP nulo.

Listas nunca retornam IP bruto. Detalhe exige capability write e prazo válido; a leitura já oculta IP após90dias e eventos após12meses. `cleanupPortalV1` remove fisicamente até100 registros por família/passagem e retorna apenas contagens. Agendar a limpeza, acompanhar backlog e repetir passagens limitadas para drenar atrasos. Uma indisponibilidade de cron exige intervenção: ocultação na leitura não prova que o expurgo físico ocorreu dentro do prazo.

O ledger `revision_event`, autoridade de revisões e tombstones de encerramento são dados de integridade, não a auditoria de acesso sujeita a essa limpeza. Não ampliar DELETE nem contornar ACL para eliminá-los. Não apagar contas ou revogações necessárias para impedir reativação.

## Sinais e reação

| Sinal | Limiar | Reação |
|---|---|---|
| IP expirado/auditoria antiga | qualquer pendência | attention; executar mais passagens de cleanup e confirmar redução |
| IP expirado há mais de5min | qualquer pendência | intervention; restabelecer expurgo, investigar falha de cron e verificar retenção |
| Job sem lease válido e atrasado | mais de5min | attention; verificar cron/DB/política e consumir a fila pelo handler com lease |
| Job esgotado | failed e attempts≥5 | intervention; corrigir a causa, preservar evidência e reencaminhar por operação autorizada |
| Consulta aguardando lock | idade da consulta≥1000ms | attention; verificar operação concorrente; não retirar locks ou executar reset para liberar |
| Lock timeout/statement timeout | contador>0 | observar SQLSTATE agregado55P03/57014, reduzir concorrência e investigar; resposta deve continuar503 sem detalhes do driver |
| Falha de chave, driver ou integridade | unavailable | manter fail-closed; conferir configuração/versões, sem fallback ou reativação |
| Outbox live pendente | profundidade agregada + idade do item devido mais antigo | observar drenagem; >5min sem lease válido entra em attention |
| Fila de publicação devida | profundidade agregada + idade do item devido mais antigo | acompanhar consumo/leases; não inferir CPU ou capacidade apenas pelo atraso |

`livePending`, `liveRetrying`, `oldestLiveDueMs`, `publicationDue` e `oldestPublicationDueMs` são agregados sanitizados e limitados. Contagens são capadas em 1001 para diagnóstico operacional; não são inventário exato acima desse teto. Idade é calculada a partir do próximo instante devido, não tempo de CPU. Nenhum desses campos contém conta, aluno, turma, payload ou erro bruto. Eles tornam backlog observável no endpoint interno, mas **não criam dashboard nem alerta externo** por si só.

`oldestWaitingQueryMs` é idade da consulta atualmente aguardando lock, não medição exata do início da espera. `pg_stat_activity` consulta apenas sessões do próprio papel e retorna agregados. O endpoint health não adquire o lock anual que precisa diagnosticar. Jobs cancelados com attempts0 não geram alerta de tentativas esgotadas.

## Composição obrigatória na #715

- Transportar IP original explicitamente e usar os serviços reais; nenhum mock no caminho habilitado.
- Emitir métricas sanitizadas fora do resultado transacional. Falhas de factory/conexão também precisam produzir unavailable, sem log do driver.
- Aplicar o gate externo de manutenção antes do negócio e da materialização; a ausência do valor explícito `true` mantém fechado. Liveness/diagnóstico autorizado permanecem úteis.
- Fornecer bindings de rate limit com namespaces únicos na conta. Proposta: global600/min e sujeito30/min; confirmar IDs antes de provisionar. O guard deve ser aplicado na borda, antes de abrir a conexão, sobre payload previamente limitado/validado. O guard opcional no serviço protege transações/KDF; sozinho não impede a conexão inicial da factory. Não contar duas vezes o mesmo pedido ao compor as duas camadas.
- Rate limit de borda é local à região e eventual. O contador por conta no PostgreSQL continua autoritativo. Não usar IP como único limitador para evitar bloquear toda a escola atrás de NAT.
- Consumir publicação por claim/lease, com limite de trabalho por invocação e observação de backlog. Não executar lote100 de KDF, nem converter as100 entradas em100 derivações numa chamada. Birth-batch usa até1KDF e até2 itens novos sem KDF, com retomada pelo mesmo payload/ator/idempotencyKey.
- Planejar frequência/volume de cron contra o backlog do escopo piloto. A carga H mede até5 chamadas simultâneas, um job por chamada e5 contas no fluxo de autenticação; não é prova de throughput ilimitado da escola inteira.

O lock anual exclusivo foi preservado: a carga delimitada ficou dentro do orçamento e a prova de timeout/diagnóstico cobre contenção. Escala além da amostra requer nova medição; não introduzir upgrade de lock compartilhado/exclusivo sem prova de corridas com escritores/reset.

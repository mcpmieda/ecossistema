# Segurança por entrada, identidade e operação — #1249

## Estado e evidência

Baseline: `main@3f5409bcb327961fc98eed3b9d4f2d7738a4f877`, conferida em 05/10/2026.
Checkpoint de 05/10/2026, 18:11 UTC: ACL 0014 aplicada e conferida; runtime da
PR #1250 ainda aguarda gates, integração e deploy. O verificador read-only da
PR #1251 já foi publicado. Sem novos serviços, secrets ou credenciais. #1128 conserva a autoridade das quatro funções/TLS; a migration desta entrega é coordenada com essa dependência. #1225 e seus
resultados F1–F6/relatórios/fila permanecem intactos. Nenhum incidente de injection
ou vazamento entre alunos foi demonstrado. Repositório não comprova deployment.

Confirmados na baseline: cookie malformado alcançava a fábrica SQL em session/me/live/
fotos; parser sem teto de header; cota coletiva consumida antes da assinatura do QR;
leituras self sem cota por conta. Já existentes: contratos estritos, origem, limite de
body, sessões/revogação, binding ADM privado, SQL parametrizado e ACL/RLS por serviço,
fotos privadas autorizadas por conta/revisão, cota independente de diagnóstico.

## Matriz de fronteiras e custo

| Família / método          | Identidade e escopo                                  | Antes do banco                                                 | Após prova de identidade / efeito bloqueado                                       |
| ------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| challenge/login POST      | assinatura QR; conta e política no serviço           | body/schema, cota entrada, assinatura/canonicalização, cota QR | contador durável/Turnstile/KDF existentes                                         |
| activate POST             | desafio opaco validado no banco, versões e uso único | body/schema; entrada e cota de desafio independentes do QR     | preflight atual precede KDF; contador/atomicidade preservados                     |
| session GET               | sessão verificada, accountId é só expectativa        | cookie plausível e cota entrada                                | conta/session antes da resposta e renovação live                                  |
| me GET                    | conta da sessão, edição scoped-v2                    | cookie e entrada                                               | conta/read antes de edição/dados                                                  |
| live GET upgrade          | conta/vínculo/prazo da sessão                        | método/query/upgrade/cookie/entrada                            | conta/live antes de classe/handshake/RPC                                          |
| status GET                | público escola; opcional sessão verificada           | método/origem e cota pública                                   | conta/status antes de política individual; 429/503 do limiter não viram escola200 |
| photo GET / content GET?v | conta e revisão autorizadas                          | método/query/range/cookie/entrada                              | conta/photo antes de metadados/storage                                            |
| logout POST               | token próprio localizado no banco                    | origem/schema; sem token limpa cookie sem SQL; entrada própria | cota logout antes da revogação; jamais partilha quota read                        |
| ADM query/command POST    | contexto Entra selado: tenant+oid/capability         | esquema/contexto privado verificados                           | read/write/revoke separado, antes SQL/RPC caro                                    |
| ADM/BN HTTP               | sessão Entra validada, capabilities originais        | origem/método, guarda/entrada onde aplicável                   | enum fechado read/import/write/export antes do consumidor                         |
| ADM live GET upgrade      | contexto do entrypoint privado                       | origem/capability/prazo existentes                             | tenant+oid/live antes do handshake                                                |
| healthz GET               | nenhuma identidade, resposta técnica fixa            | método/origem; sem banco nem quota adicional                   | exceção barata para sondas existentes                                             |
| diagnósticos POST         | payload técnico fechado, sem identidade acadêmica    | limite de bytes/schema e cota existente                        | telemetria agregada existente; não reimplementada                                 |

Navegador não fornece identidade de quota autenticada. IDs/query são filtros ou
expectativas comparadas no servidor. Abas/sessões da mesma conta partilham quota;
contas diferentes no mesmo Wi-Fi não partilham quota individual. IP não é identidade.

## Política inicial, por localidade e janela de 60 segundos

| Binding / chave                           |    Limite | Fundamentação inicial                                                                                  |
| ----------------------------------------- | --------: | ------------------------------------------------------------------------------------------------------ |
| AUTH_GLOBAL / entrada por família         |      3000 | preserva valor coletivo existente; cada família tem chave independente                                 |
| AUTH_GLOBAL + AUTH_SUBJECT / QR assinado  | 3000 / 30 | valores existentes; canonicalização evita aliases de URL; assinatura inválida não consome essas chaves |
| AUTH_GLOBAL + AUTH_SUBJECT / ativação     | 3000 / 30 | namespace/chave independentes; desafio não é conta autenticada                                         |
| SESSION_ACCOUNT / conta+session           |       120 | renovação normal45s/legado60s; margem para 10 abas/dispositivos, retomadas e eventos sem mudar lease   |
| READ_ACCOUNT / conta+read                 |       120 | carga explícita de boletim; margem para 10 abas e repetição manual sem polling                         |
| PHOTO_ACCOUNT / conta+photo               |       120 | metadata+content por carga, até 6 cargas/min em 10 abas como envelope de projeto                       |
| LIVE_ACCOUNT / conta+live                 |       120 | canais acadêmico/segurança, conexões iniciais e reconexão progressiva; não conta mensagens WebSocket   |
| STATUS_ACCOUNT / conta+status             |        60 | política consultada na entrada/estado; margem de várias abas sem cache público                         |
| AUTH_GLOBAL + AUTH_SUBJECT / logout       | 3000 / 30 | saída excepcional, orçamento independente; leitura saturada não impede revogação                       |
| ADMIN_READ                                |       600 | prefetch/ficha, batch até16,4 paralelos e várias abas preservados                                      |
| ADMIN_IMPORT / ADMIN_WRITE / ADMIN_REVOKE |  120 cada | lote de 50 arquivos pode ter persistência+diagnóstico; revogação independente da leitura/escrita       |
| ADMIN_EXPORT / ADMIN_LIVE                 |   60 cada | artefatos explícitos e reconexões; não limita alunos por lote                                          |

São margens iniciais de engenharia, não medição de capacidade nem garantia de ausência
de falsos positivos. Dois lotes grandes simultâneos pela mesma conta podem atingir a
quota de importação; a fila não é alterada. Calibrar pelo uso legítimo após autorização.
O limitador Cloudflare é local, permissivo e eventualmente consistente: não impõe teto
global preciso de consumo/cobrança. Não se exige N+1 exato em produção.

Configuração nova está somente no artefato revisável `wrangler.student-portal.jsonc`.
Namespaces 3101249–3101259 foram conferidos às 18:06 UTC: todos livres no
inventário de Workers e versões atuais. Ver a evidência ao final. A configuração
dos novos limites ainda aguardava publicação neste checkpoint; nenhuma compra
ou nova credencial foi necessária.
Pages não lista binding RateLimit: ADM reutiliza exclusivamente seu `PORTAL_SERVICE`
privado já existente. O custo extra é uma chamada RPC para quota nos caminhos HTTP
ADM/BN, sem SQL adicional; query/command/live já no Worker usam adapter local.
O selo ADM é reutilizado por escopo assíncrono da requisição, inclusive entre clones
Pages; a prova Workerd com duas identidades concorrentes mede dois AES totais, e uma
requisição posterior exige novo AES. Expiração/capabilities continuam verificadas.
Portal permitido adiciona entrada + quota de conta na mesma conexão; bloqueio de
entrada faz zero SQL, bloqueio de conta ainda paga a autorização mas zero consulta
de foto/storage posterior. Os testes conferem contagens, não latência produtiva.
A duração real adicional é indisponível até medições autorizadas equivalentes.

## Falhas, repetição e disponibilidade

- Excedente: HTTP429 e Retry-After60 conservador (provedor não expõe o instante
  exato de reset). Portal usa `rate-limited`; BN e fotos ADM conservam o envelope
  legado `unavailable` com HTTP429. Foto estudantil mantém corpo vazio e header
  de espera. Os códigos HTTP distinguem limite atingido de falha do serviço.
- Binding ausente, erro ou resposta inválida:503/unavailable, nunca429 fictício nem
  sucesso aberto. Vale para leituras, auth, mutações e logout com token plausível.
- Logout sem token plausível permanece idempotente e limpa cookie sem banco. Com token
  plausível e indisponibilidade, não fornece recibo falso de revogação.
- Status pode continuar escola para sessão não autenticada segundo contrato existente,
  mas uma falha de limitação individual não é mascarada como escola200.
- Cliente self respeita cooldown. Segurança aguarda Retry-After sem renovar prazo nem
  fazer `/me`; erro de rede mantém a política transitória existente. Não há retry novo
  automático de importação/publicação ou confirmação falsa de operação. Importação429
  apresenta a espera recebida e para pela fila existente. Cooldown de sessão não é
  contornado por novo connectionId; entradas expiradas do mapa são descartadas.
- Cookie header limitado a8192bytes UTF-8/64pares, token válido43base64url preservado.
  Guarda estrutural não autentica. Em quota pós-sessão há SQL de autorização já pago;
  a prova é zero conteúdo/efeito posterior, não zero SQL para qualquer429.

## SQL, isolamento e ACL/RLS

Inventário revisado: fachada `postgres-database-v1` (`unsafe(text, parameters)`),
queries/admin V1/V2/V3 e filtros/cursor, `session-service-v1`, self, fotos, publication,
read-set/write-buffer de importação. Valores externos continuam separados; fragmentos
estruturais vêm de constantes/condições fechadas. Apóstrofos/texto sintético não são
removidos por blacklist. `unsafe` não é, sozinho, evidência de SQL injection.
A revisão é delimitada, não certificação universal de todo SQL presente/futuro.

Modelo preservado: navegador → servidor autenticado → papel dedicado → recurso
escolhido pela sessão/capability. `USING(true)` para serviço restringe quem acessa,
não qual aluno esse serviço consegue ler. O risco residual de esquecer um filtro no
backend continua explicitamente existente. Não foram adicionados `auth.uid()`,
contexto SET persistente, BYPASSRLS, owner ou política permissiva concorrente.

As negativas existentes cobrem troca de conta/self/live/fotos, expiração/revogação,
publicação e respostas privadas/no-store. Novas provas usam SessionService real em
PGlite: A/A2 agregam quota, B mantém independência, bloqueio acontece antes da consulta
de foto, logout funciona depois do bloqueio read, indisponibilidade não revoga sessão.
PGlite/mocks não são prova de ACL da role real no PostgreSQL produtivo.

Conferência produtiva somente leitura em 05/10/2026: RLS habilitado em 31/31 tabelas
Gradebook, 28/28 Portal, 7/7 fotos e 2/2 system_health, sem owner dos papéis app e sem
FORCE. Não há grant de tabela/sequência/view para anon/authenticated nos schemas
inspecionados. As 9 views academic_* do Portal são owner postgres/security_barrier,
sem security_invoker; não fornecem uma barreira individual adicional. Ledger Portal
contém os 24 nomes de migrations esperados até 0024, versão 20261001201546.

A fotografia anterior à aplicação confirmou drift das 4 funções #1128: owner postgres, SECURITY INVOKER, ACL com
PUBLIC EXECUTE e EXECUTE gradebook_app. anon/authenticated/student_portal_app não
têm USAGE gradebook: ACL excessiva não demonstra chamada pública efetiva. O bootstrap
0001 atual já revoga PUBLIC, mas a 0013 altera somente defaults futuros; não corrige
essas ACLs produtivas existentes. Correção em 0014, com pre/postflight e
testes próprios; aplicada com postflight em 05/10/2026, 18:11 UTC. Ver [plano de ACL](../gradebook/FUNCTION_EXECUTE_1128.md).

Operador Cloudflare oficial de 05/10 às 14:25:21 UTC (run 37324541179) informa Worker/Pages
presentes, deployment success e PORTAL_DB sem cache/limite de 8 conexões. Não coleta TLS,
CA/hostname nem bindings de rate limit nessa versão anterior do diagnóstico.
TLS Hyperdrive: desde 15/11/2026, 14:52 UTC, os três Hyperdrive (gradebook-official-no-cache, student-portal-no-cache, ecossistema-collector-auth) usam `sslmode verify-full` com a CA `Supabase Root 2021 CA` enviada à Cloudflare (#1473); a Cloudflare validou cada conexão antes de salvar. Exposição Data API permanece pendente. ssl=on e TLS1.2
no PostgreSQL não demonstram validação de hostname no Hyperdrive. Nenhum dado de aluno foi consultado e nenhuma carga produtiva foi executada.
A única mudança SQL desta entrega é a ACL pontual documentada no postflight.

## Verificação e implantação

Resultados/SHAs ficam na descrição do PR final. Usar `npm run verify` e gates nativos
oficiais no head final. Os harnesses existentes recebem os novos bindings, sem retirar
asserts, relaxar thresholds ou aumentar concorrência acadêmica. Sem carga produtiva.

A configuração de segurança foi explicitamente aprovada. Antes de deploy, revalidar colisões/namespaces e
compatibilidade Pages→Worker; conferir todos bindings antes de expor handlers; publicar Worker compatível antes do Pages ADM; aplicar
somente pelo workflow oficial quando autorizado. O estado de publicação deve ser confirmado pelo workflow oficial do SHA integrado; este checkpoint não antecipa esse resultado. Drains live só são agendados após sucesso;
429/503 e logout sem token plausível não provocam SQL de background.
Rollback reverte código/config do release; não desliga origem, autenticação, RLS nem
reabre grants públicos. Validação real posterior pertence ao responsável.

Fontes: [#1249](https://github.com/mcpmieda/ecossistema-escola/issues/1249),
[#1128](https://github.com/mcpmieda/ecossistema-escola/issues/1128),
[Cloudflare Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
[Pages bindings](https://developers.cloudflare.com/pages/functions/bindings/).

### Preflight e ACL após autorização

[Diagnóstico de 05/10/2026, 18:06 UTC](https://github.com/mcpmieda/ecossistema-escola/issues/1249#issuecomment-6000251034):
1 Worker listado, 1 versão ativa a 100%, nenhum uso dos 11 namespaces novos.
Settings e versão ativa preservavam AUTH_GLOBAL=3000/60 e AUTH_SUBJECT=30/60.
Escopo do inventário: scripts.list e versões do deployment atual; não cobre
Workers for Platforms/dispatch nem reservas externas. Não é uma reserva de IDs
contra alteração posterior. [Execução oficial](https://github.com/mcpmieda/ecossistema-escola/actions/runs/37353455004).

A migration 0014 foi aplicada como `20261005151011`, com corpos, triggers,
catálogo, RLS, schema ACL e defaults preservados. PUBLIC e papéis externos perderam
EXECUTE nas quatro funções; backend e owner permaneceram autorizados.
Ver [postflight completo e limites](../gradebook/POSTFLIGHT_0014.md).

O Sonar aprovou o head 4def1958 da PR #1250 com 11 apontamentos de manutenção/estilo
(complexidade, literais repetidos, ternários, catch e optional chaining), sem nova
exploração demonstrada pela revisão. A PR #1251 corrigiu seu gate bloqueante e
foi aprovada com uma sugestão residual de estilo. Gates finais continuam exigidos
após incorporar a main; aprovação Sonar não significa ausência universal de bugs.

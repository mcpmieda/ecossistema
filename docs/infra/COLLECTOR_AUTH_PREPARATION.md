# Coletor: preparação de autorização, 14/10/2026

PR draft; nenhuma ativação, merge, deploy, consentimento, segredo ou credencial
persistente real foi feito. Nenhum aluno foi lido ou transmitido.

O broker existente cobre recibo exclusivo do coletor, assinatura P-256,
consumo transacional de nonce, revogação local em cada operação e evidência
Microsoft com validade de cinco minutos. O refresh token permanece no servidor,
cifrado com chave dedicada e vinculado à conta, grant, geração, versão e origem
imutável de autenticação. Ele não é tecnicamente limitado ao módulo pela Microsoft.

`http-v1.ts` prepara POST challenge/access, corpos pequenos, sem CORS/cookies
como autorização, respostas estritas sem tokens e cache desativado. Sem broker
configurado, retorna 503 ACCESS_NOT_CONFIGURED. Ainda não está instalado na rota
Pages, nem existe binding/credencial de produção configurado.

`oauth-v1.ts` prepara o callback interno para transação exclusiva do coletor,
confirmada pelo usuário. Reutiliza `/auth/callback`; o login comum continua com
seus scopes atuais. Somente esse fluxo solicita `User.Read`/`offline_access`.
Exige validação do ID token, nonce, autoridade e auth_time recente, sem substituir
auth_time pelo relógio do callback. Revalida conta habilitada, marcador de
revogação e grupo ADMIN via delegação própria. Retorna apenas `{completed:true}`;
o armazenamento recebe refresh cifrado, nunca o token em claro.

Faltam a confirmação no navegador e os adaptadores concretos de cookie/state,
mais a instalação dos brokers nas rotas e o provedor protegido do computador.
`pairing-store-v1.ts` agora implementa as portas de persistência do callback:
confirmar, consumir state/nonce uma única vez e criar grant/device/completar
pareamento em uma única instrução transacional. Nunca sobrescreve uma origem
antiga. A chave pública vem do pareamento confirmado, não do callback.
A migration 0002 acrescenta pairings owner-only, deadline de dez minutos,
hash de segredo temporário de polling, state/nonce com hash e cancelamento.
Ela também é candidata não aplicada. A migration 0001 permanece inalterada.
Não usar a preparação como prova de fluxo completo ou para liberar um pacote.

Testes locais: 49 regressões sintéticas em sete suítes (incluindo cinco HTTP e
cinco OAuth), mais seis testes novos de pareamento. Estes verificam segredo
de polling, confirmação obrigatória, state/nonce trocados, concorrência com uma
única conclusão, origem imutável, cancelamento, expiração e rollback do grant
quando a inserção do device falha. Tipos server e lint são gates obrigatórios.
Os testes OAuth usam verificador de token
sintético: não comprovam assinatura Microsoft real, consentimento ou propriedades
disponíveis no tenant. A validação criptográfica existente de OIDC é reutilizada
pelo contrato e ainda precisa da montagem/testes das rotas completas.

DDL autorizado pelo usuário, porém bloqueado no gate técnico do APPROVAL_PLAN:
falta readback no Dashboard de que Deploy to production está OFF. A rota de
browser local falhou na inicialização; não houve rejeição de aprovação.
Ensaio isolado PostgreSQL 17.6 passou em CI. Supabase preflight somente leitura:
schema ausente, 57 migrations; fingerprint de histórico
`2aa0f5e6ff4e5929e910baa4a9ee0f67`. Repetir o preflight antes de qualquer DDL.
SQL candidato SHA256 `db339aec4068487cbe8fafc84899fdd30d0918e7e631b93e5144855b042d3114`.
SQL 0002 SHA256 `dea6d2d6f581ffa09b3e4ebf3576f705673e0f251aa906a16213c10f5a1f856d`.
CI 17.6 foi ampliado para ensaiar 0002: rollback, aplicação única, repetição
bloqueada, ledger sintético preservado e ACL owner-only. Exigir seu sucesso no
SHA que contém ambas as migrations, sem usar sucesso antigo como prova de 0002.

Fontes: [Microsoft: scopes OIDC](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc)
e [OpenID Connect: max_age/auth_time](https://openid.net/specs/openid-connect-core-1_0.html).
O comportamento real de auth_time/User.Read no tenant ainda precisa de prova;
ausência, null, 403 ou falha de renovação bloqueiam, sem usar identidade alternativa.

# Coletor: autorização candidata, 14/10/2026

PR draft. Rotas Pages e provedor PC estão implementados; nenhum merge, deploy,
DDL real, consentimento Microsoft, segredo ou credencial persistente real foi
feito. Nenhum aluno foi lido ou transmitido. Envio continua desativado.

## Contrato e rotas

routes-v1.ts instala config, pareamento assinado, confirmação explícita no
navegador, callback exclusivo, poll/claim/cancel, challenge/access/revoke e
retirada pelo próprio usuário autenticado. A montagem ocorre após a verificação
do domínio oficial. Cookies são selados com finalidade/CSRF, state/nonce são
consumidos uma única vez e PKCE protege a transação exclusiva collector.
O código de seis dígitos vem do PC; a página de confirmação não o revela.

O login comum mantém seus scopes. Somente collector solicita openid/profile/email,
offline_access e User.Read delegado do próprio usuário. O ID token é validado
pelo verificador OIDC existente antes de ler auth_time; exige origem recente,
conta habilitada, marcador de revogação e grupo ADMIN. Falta/null/403 negam.
O refresh permanece no servidor, cifrado AEAD com chave dedicada, ligado a
conta/grant/geração/versão/origem imutável. Microsoft não o limita fisicamente ao
módulo; o PC recebe apenas recibo exclusivo curto. Não há bearer amplo no PC.

Assinaturas P-256/P1363 separam pareamento, acesso e revogação; nonce transacional
é de uso único. Revogação local é consultada a cada operação. Prova de diretório
vale no máximo cinco minutos a partir do início da consulta, sem janela cumulativa.
Revogar o próprio vínculo permanece possível sem Graph, token ou grupo vigente.
A retirada via navegador exige sessão validada e dono tenant/actor/device/key,
CSRF e confirmação; não autoriza acesso nem retira credencial de outra pessoa.

O PC salva device.json público antes do claim. Até o claim, acesso é negado.
Pareamentos vencidos sem claim são aposentados junto com device e refresh.
Cancelar cobre a corrida de conclusão; a origem de autenticação nunca é reescrita.

## Configuração e limites

runtime-v1.ts exige COLLECTOR_ENABLED=true, COLLECTOR_DB dedicado e pronto,
COLLECTOR_REFRESH_KEY AEAD de 32 bytes distinta de SESSION_SECRET e credenciais
existentes Web para a transação exclusiva. Não usa PROD_DB como fallback nem cria
grants SQL. Verifica schema e privilégios antes de oferecer ativação. Retirada
própria usa somente o store e a sessão existente. Nenhum binding/segredo foi definido.

DDL está autorizado, mas bloqueado pelo gate técnico do APPROVAL_PLAN: falta
readback do Dashboard de Deploy to production OFF. A inicialização do browser
local falhou; não houve rejeição automática de aprovação. A listagem de branches
não prova esse setting. Não reparar/reexecutar histórico ou alterar segurança.
Preflight somente leitura: schema ausente, 57 migrations, fingerprint histórico
2aa0f5e6ff4e5929e910baa4a9ee0f67; repetir imediatamente antes de qualquer DDL.
0001 SHA256 db339aec4068487cbe8fafc84899fdd30d0918e7e631b93e5144855b042d3114.
0002 SHA256 e6dd06affb78ae3f42d68995cea74aec9433b3cb86e73aa3afde34f7b3862db1.
0002 inclui claimed_at; ambas são candidatas não aplicadas. Exigir ensaio nativo
PostgreSQL 17.6 e CI completos do SHA final; sucesso anterior não prova esta versão.

## Evidência

Regressões sintéticas cobrem broker, refresh AEAD, diretório, HTTP, OAuth,
persistência e dez cenários das rotas completas (incluindo recuperação sem claim,
revogação independente do provedor, CSRF/origin/owner e expiração). O verificador
OIDC e fetch são substitutos sintéticos; não provam conta ou Microsoft real.
A revisão interna independente não encontrou achado concreto restante no escopo
revisado; TPM e persistência real no Windows permanecem sem prova.
peer-fixture-v1.ts compila os verificadores atuais para QA CNG por stdin, somente
chaves públicas/desafios/assinaturas. Não é serviço nem parte do pacote desktop.

Fontes: [Microsoft: scopes OIDC](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc)
e [OpenID Connect: max_age/auth_time](https://openid.net/specs/openid-connect-core-1_0.html).

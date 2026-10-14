# Coletor: autorização candidata, 14/10/2026

Rotas Pages e provedor PC estão implementados. O provisionamento dedicado foi
autorizado e concluído; a publicação segue os gates e o workflow oficial.
Consentimento Microsoft e primeira chave permanente do PC exigem a confirmação
na ativação. Nenhum aluno foi lido ou transmitido. Envio continua desativado.

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
própria usa somente o store e a sessão existente. COLLECTOR_DB aponta para o
Hyperdrive exclusivo 74fa00272a0b420582ccb5e55be6356f, collector_runtime, cache
desligado e TLS require. O limite Hyperdrive de 5 conexões é soft; a role também
possui CONNECTION LIMIT 5. Nenhum recurso existente foi reaproveitado como acesso
amplo. O cliente postgres 3.4.9 mantém prepared statements para Hyperdrive.

O responsável forneceu evidência visual autenticada do Dashboard com Deploy to
production OFF. O setting não foi alterado. As migrations abaixo foram aplicadas
uma vez via apply_migration após ensaio nativo PostgreSQL 17.6 e revisão independente.
Ledger: 0001=20261014081614, 0002=20261014081715, 0003=20261014084159.
As 57 migrations anteriores permaneceram idênticas. A fórmula comparável é
md5(string_agg(version||':'||coalesce(name,'')||':'||coalesce(array_to_string(statements,E'\n'),''),E'\n' ORDER BY version)),
excluindo as três novas entradas; resultado a14fbf8ac6c3497ba32d5bc1b1a883f0.
Não comparar com fingerprints anteriores produzidos por outra fórmula.
0001 SHA256 db339aec4068487cbe8fafc84899fdd30d0918e7e631b93e5144855b042d3114.
0002 SHA256 e6dd06affb78ae3f42d68995cea74aec9433b3cb86e73aa3afde34f7b3862db1.
0003 SHA256 fdcf306b473c81249b103510a43e780993fed7d453f97d9d305627ac310185db.
0003 criou a role NOLOGIN, sem senha, memberships ou ownership e concedeu somente
USAGE no schema e SELECT/INSERT/UPDATE nas quatro tabelas. Após postflight,
LOGIN e verificador SCRAM foram provisionados separadamente do ledger; senha
aleatória permaneceu em RAM/transporte HTTPS para o Hyperdrive. A chave AEAD
COLLECTOR_REFRESH_KEY foi gerada em RAM e armazenada somente como secret Pages.
Nenhum valor foi incluído no Git, pacote, relatório ou stdout. O verificador
SCRAM do provisionamento não é senha plaintext, mas continua material sensível
e pode constar no argumento privado do subprocesso ou no log SQL do provedor.
PUBLIC, anon e authenticated não recebem acesso às quatro tabelas. Não foram
alterados grants de outros módulos; metadados públicos de PostgreSQL continuam
sujeitos à política existente. Toda publicação exige CI completo do SHA efetivo,
revalidação de main e merge commit; sucesso anterior não prova uma nova árvore.

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

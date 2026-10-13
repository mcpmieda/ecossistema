# Identidade compartilhada do aluno — #1114

A entrega candidata de conciliação anual, Relatório e aba Alunos (#1269/#1276) está em [RECONCILIATION_V1.md](RECONCILIATION_V1.md). É uma extensão na branch, sem aplicação produtiva das novas migrations ou alteração do UID homologado abaixo.

## Estado de produção

A migration 0018 foi aplicada e verificada em produção, versão registrada
`20260922212633`. Evidências de preservação, catálogo e segurança estão em
[POSTFLIGHT_1114.md](POSTFLIGHT_1114.md) e no Avanço 17 da issue #1114.
Não reaplicar a migração. Integração/publicação do código são verificações
separadas, registradas na issue e na PR #1115.

## Contrato e limites

`studentUid` é o UUID imutável da pessoa, compartilhado entre Banco de Notas,
Portal e futuros consumidores de fotos. Não é nome, número de chamada, turma,
ID da planilha nem uma autorização de acesso.

`gradebook.aluno.id` continua sendo a chave numérica acadêmica. `account.id`
continua sendo a chave da conta/credenciais. Elas não são renumeradas. Os dois
registros passam a apontar para o mesmo `student_uid`. Para as contas já
existentes, esse valor é exatamente o UUID da conta, sem alterar fotos ou links.
Uma conta criada depois pode ter uma chave interna diferente: consumidores
transversais usam `studentUid`, nunca uma suposição de igualdade entre PKs.

UUIDs já persistidos são aceitos em formato canônico hexadecimal 8-4-4-4-12,
normalizado em minúsculas, sem exigir bits de versão/variante RFC. O banco pode
armazenar esses valores e a migração não deve torná-los ilegíveis no contrato.

Esta entrega prepara a identidade; não implementa editor, leitura HTTP de fotos,
remoção de fundo, novo fluxo de matrícula ou redesign. Não modifica os DTOs
acadêmicos antigos nem cria endpoint público ou novas permissões de pessoas.
A branch incorpora a main publicada pela PR #1116 e as correções posteriores
até #1118; a capa pronta não é refeita.

## Persistência

Migration: `migrations/student-portal/0018_shared_student_identity_v1.sql`.

- `gradebook.student_identity(id, created_at)` é o registro durável sem dados
  pessoais duplicados e sem dependência de um ano letivo.
- `gradebook.aluno.student_uid` e `student_portal.account.student_uid` são
  obrigatórios e referenciam a identidade. Pessoa/ano são únicos em cada módulo.
- A FK composta da conta exige correspondência de aluno, ano **e** identidade.
- A criação normal de aluno aloca sua identidade mesmo sem conta. A criação da
  conta vinculada reutiliza a identidade acadêmica, sem depender da PK da conta.
- Backfill utiliza somente a FK já existente, não nomes. Contas encerradas
  conservam sua própria identidade, sem inferir correspondência pelo histórico.
- Encerrar o vínculo conserva `student_uid`; a guarda atual de reset continua
  válida. Excluir a linha anual não exclui o registro de identidade nem a conta.
- Reutilizar um número acadêmico depois do reset gera uma identidade nova.
  Reimportar a mesma linha ainda existente conserva sua identidade.

### Reutilização de identidade não é aprovação de rematrícula

Um papel normal de runtime **não pode fornecer um UUID existente para criar
outra matrícula**, nem atribuí-lo a uma nova conta encerrada. A existência do
UUID no registro, o conhecimento de seu valor ou um nome coincidente não são
uma aprovação. Esta entrega não oferece rematrícula/fusão de pessoas; esse
fluxo futuro exigirá decisão explícita, auditoria, conflitos e contrato próprios.

Dois guards `SECURITY INVOKER` verificam o `current_user` efetivo antes dos
alocadores privilegiados. Eles aceitam replay da mesma referência existente,
mas rejeitam reutilização fornecida pelo runtime para uma referência nova.
A exceção é o **proprietário real da tabela**, para restaurar um snapshot
previamente autorizado. Não se usa `session_user`, parâmetro do cliente ou flag
de sessão para conceder essa exceção. Uma conexão proprietária usando
`SET ROLE gradebook_app` continua sendo tratada como runtime.

As triggers de entrada têm prefixo `_00_` para executar antes das alocadoras.
As alocadoras `SECURITY DEFINER` são estritamente delimitadas, sem SQL dinâmico,
com `search_path=pg_catalog` e objetos qualificados. As quatro funções são
somente triggers, sem EXECUTE público/de runtime. Não há RPC de escrita de UID.
Uma nova conta sem vínculo e sem UID recebe UUID novo: escolher sua PK não
permite capturar uma pessoa já registrada. Contas existentes não são afetadas.

O registro possui RLS. `gradebook_app` pode lê-lo, mas nenhum papel de runtime
pode inserir, alterar, excluir ou truncar suas linhas diretamente.
`student_portal_app` não recebe acesso ao schema acadêmico. Alterar
`student_uid` de um registro existente é rejeitado, inclusive em correções de
nome e tentativas de reassociação. Não reparar duplicatas trocando UUIDs.

## Leitura compartilhada

- Contrato: `shared/student-identity/student-identity-v1.ts`.
- Leitor: `server/student-identity/resolve-student-identity-v1.ts`.
- Até 500 referências por chamada, um ano explícito, um SELECT parametrizado.
- Origem Banco: `{source:'gradebook', academicYear, studentIds:[inteiros]}`.
- Origem Portal: `{source:'portal', academicYear, accountIds:[UUIDs de conta]}`.
- Ambos devolvem o mesmo `studentUid`; a resposta mantém a referência de origem.
- Referências inexistentes são omitidas. Duplicidade, inconsistência, erro de
  schema e indisponibilidade não são mascarados como aluno sem identidade/foto.
- Parâmetros JSON são enviados como texto e convertidos no SQL, evitando dupla
  serialização pela inferência do driver PostgreSQL.
- O chamador autoriza previamente operação, ano e cada aluno, usando seu papel,
  conexão e transação existentes. O leitor **não concede autorização**.
- Um chamador autorizado pode resolver a identidade de uma conta encerrada;
  isso não reabre conta, sessão, publicação nem acesso do aluno.

Nenhum consumidor deve converter um número acadêmico em UUID, procurar pessoa
pelo nome ou usar conhecimento de um UUID como prova de autorização. Na entrega
posterior de fotos, adaptar referências legadas `profile_photo.account_id` via
a conta, sem renomear os arquivos existentes no SharePoint.

## Implantação e recuperação

O arquivo no Git **não comprova aplicação em produção**. A issue #1114 separa
código, testes, revisão, integração, publicação, autorização/aplicação de schema
e pós-condições. A aplicação efetiva da 0018 está em
[POSTFLIGHT_1114.md](POSTFLIGHT_1114.md). O protocolo abaixo foi usado na aplicação
e permanece referência para restauração em alvo novo, não instrução de replay
sobre a produção já migrada.

1. Confirmar baseline/ausência da migração e integridade dos vínculos. Registrar
   apenas contagens e checagens sanitizadas, nunca UUIDs, fotos ou sessões reais.
2. Validar testes de contrato/importação/migração/restore, `npm run verify` e
   gates oficiais no head final, incluindo a main atualizada.
3. Aplicar uma vez, em janela de escrita controlada e com autorização de schema.
   A migração é transacional, adquire o lock global do protocolo existente e
   falha por timeout em vez de esperar indefinidamente.
4. Comparar os campos preexistentes de alunos/contas, versões, credenciais,
   sessões e referências de fotos. Confirmar zero vínculos divergentes.
5. Executar `assertStudentIdentitySchemaV1`: catálogo exato da extensão,
   identidade completa, RLS/ACL, funções e triggers habilitadas com modos de
   execução corretos. Cada FK exigida precisa **existir**, estar validada e
   referenciar as colunas/tabelas e ações RESTRICT esperadas.

Falha dentro da transação reverte o conjunto. Depois do commit, não apagar o
registro/colunas nem regenerar UUIDs como rollback improvisado: manter o código
anterior compatível, bloquear o consumidor novo e revisar o incidente.

Restore exige janela exclusiva, processo autorizado e trilha operacional da
restauração. Carregar o registro de identidade antes de alunos/contas/fotos,
atuando como os respectivos proprietários das tabelas. Não conceder propriedade
ou elevação aos papéis de runtime para facilitar restore. A exceção técnica do
proprietário **não implementa um fluxo comum de rematrícula** nem dispensa
aprovação/auditoria operacional. As exigências existentes de quarentena e
reconciliação das credenciais após restore permanecem.

## Testes e evidência

Os testes de contrato exercitam limites, consulta única, origens, faltantes,
erros e ambiguidades; `persisted-uuid-v1.test.ts` cobre UUIDs canônicos sem bits
RFC e rejeita representações não canônicas no transporte.

A suíte PGlite usa schema real, importador V11 e população Portal, backfill sem
alterar credenciais/fotos sintéticas, homônimos, replay, imutabilidade e reset.
Inserções com UID explícito feitas pelo proprietário nessa fixture representam
a capacidade de restauração, não permissão de rematrícula do runtime.

O arquivo nativo PostgreSQL cobre upgrade/restore com UUID não-RFC, driver real,
papéis restritos, rollback, tentativa de reutilização em outro ano, captura de
identidade por conta encerrada/PK, FKs ausentes/não validadas/incorretas e modo de
segurança do guard. Todas as massas são sintéticas em bancos descartáveis.

Os estados YAML são lidos estruturalmente pelo carregador YAML da API pública
do Prettier já instalado, sem parser artesanal ou dependência de produção nova.
Há regressões para YAML inválido, bloco em nível errado e preservação do
checkpoint histórico #668.

A existência dos testes não significa que passaram: execução, SHAs, resultados
e limitações ficam na issue/PR. Restore sintético não é backup gerenciado nem
prova de RPO/RTO institucional. Smoke autenticado e visual produtivo permanecem
validações separadas.

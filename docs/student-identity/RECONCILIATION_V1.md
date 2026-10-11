# Conciliação de alunos V1 — entrega 1 da #1269

Contrato candidato registrado na [#1276](https://github.com/mcpmieda/ecossistema-escola/issues/1276), subordinado ao corpo consolidado e aos complementos aprovados da [#1269](https://github.com/mcpmieda/ecossistema-escola/issues/1269). Base inicial: `main@7119308fbbd7d870d9d0957ea2e18fa93184e042`. Esta documentação descreve a branch; não altera a baseline de `PROJECT_STATE.yaml` nem comprova integração, aplicação de migrations ou validação produtiva.

## Fronteiras e fontes

- `shared/student-identity/reconciliation-normalization-v1.ts`: comparação única, compartilhada com a Relação; datas civis completas, Excel 1900/1904 e INEP sem conversão destrutiva.
- `shared/student-identity/reconciliation-v1.ts`: requisições/retornos estritos da aba Alunos. Pessoa acadêmica tem UID e conta opcional; pendência externa tem origem/lote/linha, sem UID inventado.
- `server/student-identity/reconciliation/`: plano, preparação, revisão, aplicação, decisões, paginação e resolvedor interno de origem. Sem React, arquivo bruto ou colunas cadastrais livres.
- `src/features/gradebook/import/student-report-reader-v1.ts`: adaptador Smecel V1. Lê no navegador, seleciona a allowlist e envia células tipadas; servidor revalida integralmente o escopo e C3 antes de gravar lote ou dados pessoais.

O adaptador reconhece os cabeçalhos `Nome do aluno`, `Turma`, `Turno`, `Etapa`, `Situação da matrícula`, `Data da matrícula`, `Data da transferência`, `Hash da matrícula`, `Código INEP`, `Nascimento` e `Filiação 1`. A estrutura foi conferida em arquivo local autorizado, sem copiar pessoas, dados cadastrais, contagens ou conteúdo para repositório/CI. Fixtures reproduzem somente formato e rótulos de turma/etapa/turno. Nome do arquivo não prova data nem ano da origem.

A Relação conserva as posições e fatos acadêmicos. O nome original de cada fonte é preservado; Alunos e a projeção do Portal adotam a fonte configurada, com padrão Relatório e fallback quando a fonte não tem a pessoa. Trocar fonte não altera UID, notas, conta ou autorização. Leituras de nome bruto da Relação na importação continuam sendo evidência da fonte acadêmica, não prova derivada do nome adotado.

## Operações e atomicidade

`POST /api/student-reconciliation/v1` exige sessão ADM, origem oficial e capacidade de leitura/escrita das configurações conforme a operação. Corpos têm limite de 8 MiB/10.000 linhas, schema fechado, ano explícito 2026 e resposta privada `no-store`. Histórico/candidatos são retornados somente no detalhe solicitado. O cursor é selado e vinculado a ator, filtros, geração/revisão e expiração.

1. `prepare` valida todas as linhas elegíveis e gera plano consistente. Datas de nascimento ausentes/inválidas/futuras rejeitam o lote inteiro. Modalidades excluídas nunca são persistidas. Sem Relação, somente turmas reconhecidas como regulares ficam pendentes, sem UID/conta; com Relação, persistem apenas as turmas ligadas. Rótulos desconhecidos exigem confirmação de elegibilidade.
2. `stage` chama a capacidade privada do Portal. A KDF existente é executada fora da transação final, no máximo quatro verificadores por chamada, com salt individual e pepper existente. O navegador recebe apenas progresso. Estágio/recibos não prorrogam a validade com retries.
3. `apply` serializa o ano e o escopo, confere geração/revisões/CAS e ativa origens, observações, vínculos, perfil, decisões, nascimento e PIN numa única transação física. A função estreita do Portal executa na conexão acadêmica sem conceder leitura geral de credenciais ao runtime acadêmico. Falha em qualquer item desfaz toda a ativação.

Datas são `DATE`/texto civil nos limites SQL; nunca um `Date` convertido pelo fuso do host. Horário operacional é do servidor. A alteração apenas de dia/mês não regenera o PIN. Nenhuma conciliação cria conta, muda elegibilidade, distribui acesso ou une contas/UIDs. QR, senha, sessão e foto têm seus próprios contratos preservados.

Digests de conteúdo são calculados no servidor e preservam multiplicidade/valores de exibição, sem depender da ordem das linhas. Chaves idempotentes são distintas do digest e do hash de matrícula; repetição de uma operação concluída retorna recibo, enquanto reutilização com payload diferente conflita. Mesma planilha numa base alterada exige novo plano. Relatório antigo, com perda de origem/turma ou sem evidência temporal e conteúdo alterado exige conferência; confirmação obsoleta não vale sobre outra revisão.

## Identidade e decisões

Continuidade de uma origem é apurada separadamente da pessoa. Hash, posição e nome isolados não constituem identidade. As três regras aprovadas e todos os vetos vivem no domínio central: nome/turma única; INEP/nascimento completo; nome/nascimento/Filiação 1 para INEP alterado. N origens podem apontar ao mesmo UID; o perfil aponta para uma observação completa, sem misturar campos.

Rejeição/separação/liberação são decisões duráveis por par interno. Corrigir ligação de turma marca os vínculos afetados para conferência e conserva o estado anterior. Confirmar/separar é explícito e usa CAS. Reversão acrescenta evento e não sobrescreve correções posteriores: dependência incompatível retorna conflito sem reversão parcial. A restauração do nascimento legado, quando aplicável, fica restrita à ponte privada e à decisão original ainda compatível.

Na Relação, outro UID/evidência de pessoa ocupando a mesma posição bloqueia o reuso que herdaria notas. Correção de nome sem conflito verificável continua permitida. Par recíproco seguro de movimentação conserva uma identidade; duas identidades persistidas nunca são fundidas por essa entrega. Suspeitas sem evidência suficiente ficam para conferência, sem comparação difusa.

`resolve-source-v1.ts` oferece somente o contrato interno `resolved`/`ambiguous`/`not_found`, considerando nomes/turmas históricos e decisões centrais. UID só aparece quando a origem identifica unicamente a pessoa. Coleta, deduplicação e persistência de frequência pertencem à segunda entrega; a PR #1268 não foi integrada.

## Migrations e retenção

Ordem das candidatas, sobre a baseline histórica já aplicada: `gradebook-simplified/0015_student_reconciliation_v1.sql`, `student-portal/0025_reconciliation_credentials_v1.sql`, `gradebook-simplified/0016_reconciliation_year_reset_v1.sql`. Não reaplicar nem reescrever migrations históricas. A execução em produção depende de autorização posterior.

Objetos anuais têm RLS/ACL explícitas, FKs compostas e exclusão controlada sem cascata. Observações/decisões publicadas são imutáveis. A ponte tem proprietário mínimo sem BYPASSRLS/propriedade de tabelas, `search_path=pg_catalog` e EXECUTE revogado de papéis públicos. A Data API não expõe essas tabelas.

Pendência anterior à Relação dura 30 dias, com aviso a partir do dia 27; preparação ordinária dura 24 horas; estágio de credenciais dura no máximo uma hora. A manutenção existente elimina expirados em lotes limitados, revalida sob lock e alerta sem conteúdo pessoal. Não há automação de ChatGPT nem consulta periódica da escola inteira.

O reset inclui prévia/contagens dos objetos novos e funciona também para pendências anteriores à Relação. Exclui dependentes explicitamente e troca a geração, impedindo replay de preparação antiga. Conserva a guarda de contas/vínculos e não apaga identidades globais ou fotos.

## Limpeza e transição de consumidores

| Item | Destino nesta entrega |
| --- | --- |
| Editor/autosave/batch de nascimento no navegador | Retirados; ficha de nascimento somente leitura. |
| Serviço produtivo manual de nascimento e port de escrita | Retirados; operações antigas recebem rejeição autenticada mesmo com cliente antigo. |
| `birth-write`/`birth-batch` nos DTOs antigos | Tombstone para rejeição/compatibilidade de clientes; não gravam. |
| Emissão/reemissão de QR e download de cartões | Componente próprio, sem depender do editor de nascimento; autorização, seleção e idempotência preservadas. |
| Leituras de nascimento do Portal | Leitor único `account_birth_v1`, consumindo observação canônica e legado preexistente somente na transição permitida. |
| `account_access_data` e fixtures de nascimento antigas | Fonte produtiva sem novo writer; retenção transitória necessária à migração/reversão. Helpers antigos somente em testes isolados, nunca fallback produtivo. |
| Reparo legado que movia notas entre duas identidades | Retirado; conflito de identidade permanece explícito. |

Não declarar retirada física do legado antes de terminar a transição de dados e dependências no ambiente autorizado. Não publicar dados pessoais ou snapshots reais para provar essa transição.

## Verificação e uso posterior

Regressões: domínio/normalização; parser e UI sintéticos; testes de Relação; `reconciliation-core.postgres.ts`, `reconciliation-pending.postgres.ts`, `reconciliation-credentials.postgres.ts` e reset nativo. Cobrem atomicidade, CAS, idempotência, C3, pessoas sem conta, pendências sem UID, reversão/rejeição, mudança de turma, leitores, ACL e preservação dos recursos. O fluxo anterior à Relação comprova aviso/expiração, ativação e equivalência da ordem inversa; perfis N→1 conflitantes exigem uma observação inteira, sem misturar campos. O lote sintético de 512 pessoas verifica consultas limitadas e uso de índice. O harness Workerd mede a preparação real da KDF, mantendo os limites de latência/consultas existentes; a rejeição das escritas manuais é uma regressão separada. Evidência do head final e gates fica na PR; teste isolado não equivale a validação em produção.

Após a revisão da PR, a liberação produtiva exige planejamento das novas migrations e publicação oficial, ambos fora da autorização desta execução. O responsável conduz a conferência funcional com fontes reais no ambiente autorizado: importar Relatório, conferir ligações/turmas/pendências, verificar nome configurado e QR/PIN existentes, e avaliar avisos/reset sem ensaio destrutivo de dados reais. A #1269 permanece aberta para frequência e liberação posterior.

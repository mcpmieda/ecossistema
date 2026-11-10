# Contas e ficha administrativa — #753

Autoria identificada como CHAT ONLINE, execução direta CODEX sequencial autorizada.
Base integrada/publicada: e211e290a12352815d73db32754dd5a00ca56b87.
Esta entrega fornece módulos; a montagem nas rotas reais pertence à #757.

## Composição

- Criar uma instância estável de createPortalAdminReadClientV2, do client V1
  existente e de createPortalClassCatalogV2. O primeiro também permite overview
  para #756; não altera o client V1 nem o protocolo de comandos.
- StudentAccountsV1 exige reader, client, catalog, scope, canWrite e identityKey.
  identityKey deve mudar com a identidade administrativa, inclusive logout.
  O ano do Portal continua2026, independentemente do seletor global do BN.
- scopeLabel e describeScope são apresentação opcional, nunca identidade.
  A lista filtra nome literal, estado de autenticação, bloqueio administrativo
  e turma; catálogo autorizado BN integral, incluindo turmas sem contas.
- Páginas usam100 como limite, cursor opaco do servidor e histórico de navegação
  somente em memória. Não há contagem total inventada nem exportação snapshot.
  Cursor expirado pede primeira página/recarga; filtros descartam seleção/cursor.
- Seleção usa accountId. A ficha consulta novamente o escopo individual antes
  de oferecer ações; verifica identidade e turma do escopo de origem.
  Alterações de página mantêm a ficha da conta selecionada, não da posição.
- Tabela com altura limitada, cabeçalho fixo, rolagem horizontal e Avatar de
  iniciais. A ficha recebe foco depois de carregar; fechar retorna à linha ou,
  quando ela já não existe no DOM, ao controle de atualização da lista.
- Slots opcionais birth/credentials/sessions/publication/audit/settings recebem
  AccountSlotContextV1 (account, scope individual2026, canWrite, refresh).
  #757 encaixa #754/#755/#756/#752/#751 nesses slots. Não montar versões
  concorrentes de manutenção nem interpretar ausência de slot como dado vazio.
- Cada slot deve limpar seus drafts/dados ao mudar identidade, accountId,
  capability ou escopo, e chamar refresh depois de um commit que altere a conta.
  Não tomar a versão de uma página anterior como CAS de nascimento/credenciais.

## Contrato e semântica

Extensão administrativa mínima registrada previamente na issue: linkClosed:boolean
obrigatório em accounts-read V2, projetado diretamente de closed_at.
O schema já exige que a conta encerrada tenha vínculo nulo/eligibility=unlinked.
A hipótese inicial de encerramento com vínculo ainda ligado foi descartada por
esse constraint; o teste não o remove nem o enfraquece. O campo explícito evita
reconstruir no browser a regra física ou inferir encerramento de access.unresolved.
Não muda V1, query SQL, migration, ACL, autoridade ou dado acadêmico.

Última autenticação é o sucesso retido nos últimos12 meses, em America/Sao_Paulo.
Null significa desconhecido nessa janela, nunca “nunca acessou”. Acesso configurado,
origem, permissão efetiva e credenciais válidas são fatos diferentes.
Vínculo ausente/encerrado/não resolvido impede ações de credenciais. Não há
reassociação por nome, pesquisa externa, importação de alunos ou edição de nomes.
Saída da escola e bloqueio administrativo continuam separados.

## Comandos

AlertDialogs separados para block/unblock, password-reset, account-reset e
qr-regenerate, com efeitos explícitos e botão Cancelar como foco inicial.
CAS e idempotência são capturados na revisão. Nenhum sucesso otimista.
Resposta incerta retém os bytes preparados; repetir preserva integralmente a
intenção. Conflito exige recarga/nova revisão; Retry-After impede repetição precoce.
Abort e geração descartam respostas antigas sem fingir cancelar commit no servidor.
401/403 removem ficha/lista; a composição também deve tratar onUnauthorized e logout.

Bloqueio/desbloqueio é administrativo; não afirma remover a janela antiabuso.
Redefinir senha preserva QR; resetar conta gira QR e volta ao primeiro acesso;
regenerar QR preserva senha/estado. Todos respeitam as revogações do backend.
Nenhuma dessas operações encerra vínculo ou libera reset anual do Banco.

QR retornado vai apenas ao callback privado onQr(result, signal). Nunca entra em
estado genérico, DOM, URL, clipboard, storage ou log do módulo. O callback de #755
deve respeitar o signal e apagar o artefato ao trocar contexto.
Falha ao abrir o artefato depois do commit orienta reimpressão, sem repetir rotação.
onReprint recebe contexto, sem duplicar emissão/PDF. Account-reset retorna somente
recibo de commit; a reimpressão é a operação própria para obter seu novo cartão.

## Evidências e limites

Testes: transporte/contrato V2, catálogo integral/filtros/ano, página105 com cursor,
identidade persistente entre páginas, detalhe CAS fresco, conflito/nonce novo,
resposta perdida/retry exato, envio duplo, cancelamento/late response, Retry-After,
proteção de credencial/callback após commit, readonly, vínculo encerrado,
troca de identidade/capability, busca obsoleta e expiração durante comando.
Casos compartilhados de leitura passam no PGlite e são executados no PostgreSQL
nativo/role restrita pelo gate de CI. Checkpoint no head final fica na issue/PR.
O caso de resumo excessivo inclui criar/remover5.001 contas sintéticas: seu limite
local é30s, após timeout do padrão5s no Windows (6,537s, CI passou). É uma prova de
recusa/ausência de totais truncados, não um SLO de latência; as asserções permanecem.

QA local em build Vite compilado com CSP exata do ADM:1280×850,390×740,320×700.
Lista105 e catálogo106 (incluindo última turma vazia), ficha/foco, retorno,
cancelamento pelo teclado, operações distintas sintéticas, conflito, resposta
perdida, expiração, readonly, troca de identidade e indisponibilidade verificados.
Console sem erros/avisos. Em320px os botões do diálogo empilham sem cortar palavras.
Browser Act está bloqueado pela política do Windows; usada a CUA disponível sem
contorno da política. Helpers/aba/viewport encerrados depois da revisão.

O mínimo global de320px do ADM causa document320/client305 com scrollbar15px;
o módulo mede288px. É o problema global já encaminhado pela #751 para #757/#758,
não motivo para expandir esta entrega a src/styles.css.
Sem mutações em contas reais, distribuição de QR, alteração produtiva de nascimento,
calendário, população ou notas. Piloto autenticado e dispositivos reais: #759.
Rollback de código compatível preserva schema, dados, identidade e revogações.

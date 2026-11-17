# Flow "AUTO | Grupos por Cargo"

Flow do Power Automate (ambiente Default, recorrência de 5 min) que coloca cada pessoa no grupo de papel do Ecossistema pelo cargo (`jobTitle`) do Entra. As regras ficam na lista `AUTOMAÇÃO - REGRAS DE GRUPOS` do site ARQUIVODIGITAL e são editadas em Configurações › Grupos do Centro (#1513). O flow só adiciona; remover continua manual, pela tela de grupos.

Listas usadas: REGRAS (regras), `AUTOMAÇÃO - ESTADO DOS USUÁRIOS` (última situação de cada pessoa) e `AUTOMAÇÃO - LOG DE GRUPOS` (registro). O Centro lê as três; só escreve em REGRAS.

## Versão `V1-PRODUCAO-R3` (17/11/2026, entrega 6 da #1513)

**Registro.** O LOG guarda só mudanças reais e erros:

- adição real ao grupo (`ADICIONAR`) ou troca de cargo de quem já era membro (`ALTERACAO_CARGO`); a simples confirmação de quem já era membro não gera linha;
- primeira vez que a pessoa aparece ou mudança de situação, cargo ou conta habilitada (`SEM_REGRA`, `ANALISAR`, `IGNORAR`);
- erro quando começa, quando o cargo muda e, se persistir, uma vez por dia (288 execuções).

A reverificação diária de cada pessoa continua acontecendo e atualizando a ESTADO, mas sem linha no LOG quando nada mudou.

**Paginação.** Usuários, ESTADO, REGRAS e membros do grupo são lidos além dos 100 primeiros (até 5.000). Quem tiver mais de uma linha na ESTADO tem a primeira atualizada, sem criar outra.

**Limpeza diária.** Na execução das 06:00 UTC (03:00 de Brasília), o flow apaga do LOG as linhas com mais de 30 dias que não são erro e qualquer linha `JA_MEMBRO` antiga. Erros ficam guardados.

## Alterar o flow

A definição é lida e gravada pela API do Power Automate (`api.flow.microsoft.com`, `flows/{id}?$expand=properties.definition`) com a conta administradora do tenant, dona das conexões. Antes de gravar, guarde a definição atual para poder voltar, mantenha `VersaoFluxo` com a nova versão e confira as próximas execuções. Mudança de regra de negócio do flow é registrada na #1513.

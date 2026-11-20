# Arquitetura — estado relacional e consumidores em transição

Retirada solicitada em 10/10/2026: a candidata remove a aba Relatórios e seu módulo institucional V1/V2. O endpoint antigo responde 410 autenticado; Desempenho/PDF docente, Conselho e Auditoria permanecem; a aba Boletins foi removida depois, em 20/11/2026. [Escopo e consumidores](REPORTS_RETIREMENT_20261010.md). Entrega em branch/PR rascunho, sem integração ou publicação.

Base integrada: `main@265d9ec886e3d9d5ad1f2b6d9e6af0a2ad3f6bce`; Conselho relacional #648/PR #653, Boletins V2 #654/PR #655, Relatórios V2 #656/PR #657, Auditoria atual #658/PR #659, configuração docente #660/PR #661, recuperação/contenção #662/PR #663, retiradas seletivas #664/#666 e refinamentos de Desempenho até #672/PR #673 integrados e publicados. A #674 prepara a trilha humana da Auditoria: a migration foi autorizada/aplicada/postvalidada, enquanto o código ainda está fora da base integrada na PR #675. O [mapa por consumidor](CONSUMER_MAP.md) é parte deste documento.

## Caminho integrado de importação

```text
Relação + planilhas dos professores, lidas no navegador
  → reconhecimento e normalização para payload canônico V9
  → POST /api/gradebook/import-persistence
  → withOfficialGradebookDatabaseV1
  → Hyperdrive PROD_DB → PostgreSQL/Supabase
  → createGradebookImportService (sobre createRelationalImportWriter)
  → fatos relacionais de estado atual; nota/instrumento granular sem histórico de valor anterior
```

A Relação é mestre para nome/situação/vínculo. Notas referenciam instrumento/aluno; oferta é ano/turma/disciplina/professor. Valores em milésimos e `N/C` não são confundidos com vazio. `AM/U` permanecem referência independente; totais derivados pertencem ao motor. Arquivo original não é alterado.

A unidade acadêmica de escrita e idempotência foi homologada na #613. Atualização de diagnóstico operacional pode ocorrer mesmo em `no-changes`; isso não é DML acadêmico.

## Auditoria de importação atual

`GET/POST /api/gradebook/import-diagnostics` usa `gradebook.importacao_diagnostico` e resolve identificação do aluno por turma/vínculo/cadastro. A última observação de arquivo/ano substitui as ocorrências anteriores, conforme #629/#862; diagnósticos resolvidos e seus tratamentos humanos não permanecem como registros órfãos. A #658 monta somente a leitura desse estado corrente. A #664 retirou a página e o endpoint dedicados do Audit Workspace V1 após provar ausência de consumidor; o runtime V1 foi posteriormente arquivado pela #1079 e não é fallback nem histórico humano durável.

A fotografia persistida e a apresentação operacional do preflight retêm apenas achados acionáveis para o usuário: `blocking-error` e o warning `above-maximum`. Avisos técnicos/esperados como recuperação sem resultado calculado salvo e máximo qualitativo `*` continuam existindo internamente para preservação/normalização fail-safe, mas não poluem a Auditoria nem a lista de avisos para revisar; nenhum deles altera fatos acadêmicos por si só.

## Provedor não é modelo de dados

Mapa atual e critérios de classificação: [STORAGE_RUNTIME_MAP.md](STORAGE_RUNTIME_MAP.md).

`withOfficialGradebookDatabaseV1` seleciona provider e, no caminho PostgreSQL, injeta um facade compatível em `GRADEBOOK_D1`. Isso permite que tipos ou nomes `D1ReadDatabaseV1`, `D1WriteDatabaseV1` e `d1-*` apareçam em código que executa em PostgreSQL.

O facade traduz sintaxe/parametrização; não reconstrói tabelas `academic_*_streams`, `*_versions`, snapshots ou sessões removidas. Consumidor que consulta essas relações não está migrado apenas porque recebe PostgreSQL. Não retirar o facade/portas ainda usados pelo importador.

O parser de ambiente ainda possui default `d1` quando a variável não é informada; isso é uma dívida separada (#970/B-08), **não um fallback físico de produção**. O wrapper oficial só permite D1 em local/preview e falha fechado em produção sem `provider=postgres` + `PROD_DB`. As rotas administrativas históricas também usam PostgreSQL em produção; migrations pelo caminho antigo estão retiradas.

## Projeções relacionais e motor

Desempenho e Portal chamam `resolve-simplified-academic-engine-v1.ts` e `resolve-simplified-annual-outcome-v1.ts`; nenhuma segunda fórmula é acrescentada na UI. A projeção oferta/aluno `relational-academic-projection-v1.ts` (`projectMany`, PR #636) era usada só pelo Boletim e foi removida com a aba em 20/11/2026.

A precedência de situações terminais continua no núcleo/serviço anual. O fato de não calcular resultado para ASSISTIDO não dispensa uma futura projeção de visualização das suas notas quando exigida pelo contrato de Desempenho.

## Consumidores e reancoragem

O catch-all mantém os transportes vigentes de Desempenho e Conselho, com os tombstones legados da #1079. Relatórios institucionais V1/V2 são retirados nesta candidata; o tombstone dedicado responde 410 autenticado antes de qualquer composição PostgreSQL. Nenhum núcleo acadêmico ou snapshot foi removido. Ver `CONSUMER_MAP.md`.

A aba Boletins do Banco de Notas foi removida em 20/11/2026 (pedido do responsável), com `POST /api/gradebook/bulletins` e `gradebook.boletim_snapshot` (migration `0022`); será refeita. O Boletim do Portal do Aluno não é afetado.

Relatórios V2 foi um agregador read-only dos contratos relacionais; seu módulo é retirado nesta candidata. Os serviços originais permanecem em suas áreas. Ver [REPORTS_RETIREMENT_20261010.md](REPORTS_RETIREMENT_20261010.md).

Auditoria atual V2 apresenta a fotografia de diagnósticos de 2026. A substituição transacional da fotografia continua pertencendo ao fluxo de importação. A #674 acrescenta, em relação privada e append-only separada, somente reconhecimento e anotação humanos; não resolve achados nem altera fatos acadêmicos. A migration está aplicada e o código segue a integração da PR #675. Ver [RELATIONAL_CURRENT_AUDIT_V2.md](RELATIONAL_CURRENT_AUDIT_V2.md) e [RELATIONAL_AUDIT_TREATMENT_V1.md](RELATIONAL_AUDIT_TREATMENT_V1.md).

Alvo: PostgreSQL/fatos → núcleo acadêmico → read models compactos → experiências. Decisões humanas têm requisitos próprios de durabilidade; não inventar resultados ou snapshots para preencher lacunas.

## Segurança e publicação

Mesmo shell, Entra e autorização server-side. Respostas acadêmicas `no-store`, sem storage persistente no browser. Os handlers e gates têm composições diferentes; não declarar todas as rotas OFF/ON por uma única flag documental. #648/#654 não alteram binding, segredo ou identidade; suas relações novas têm ACL mínima para a role backend já provisionada.

Logs não podem divulgar payloads, SQL sensível, credenciais ou dados acadêmicos. Homologação de autenticação, consistência, frescor, concorrência e recuperação ocorre por consumidor antes do aceite #347/#406/#596.

Versão anterior integral: [`history/pre-final-1/ARCHITECTURE.md`](history/pre-final-1/ARCHITECTURE.md). Documentos D1 e runbooks de migração antigos permanecem memória técnica, não instrução para recriar o schema removido.

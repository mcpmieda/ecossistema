# Boletins relacionais V2

A página montada pelo shell usa `RelationalBulletinPageV2`, o contrato compartilhado V2 e o endpoint existente `/api/gradebook/bulletins`. O handler preserva V1 como compatibilidade não montada e despacha V2 somente com PostgreSQL autorizado.

## Invariantes

- contexto vindo do seletor global de anos materializados pela Relação; sem comparação entre anos;
- turma/alunos/ofertas/instrumentos/notas/fechamentos vêm das relações atuais;
- AM/U importadas são oficiais; o cálculo do sistema serve só para conferência;
- disciplinas seguem a ordem de apresentação da fonte;
- REC normal, `N/C` e `R/R` aparecem junto da AM; qualquer `R/R` produz `REPROVADO`, sem Conselho, e `ASSISTIDO` não recebe resultado geral;
- no anual terminal por `R/R`, AM oficiais continuam obrigatórias, mas lacunas do cálculo apenas descritivo e a U inexistente não bloqueiam emissão;
- prévia não persiste; emissão pronta é append-only/idempotente/CAS;
- lote limitado a 50 alunos; materialização acadêmica não faz N+1;
- reimpressão usa somente o snapshot histórico;
- falha ou ausência de valor oficial necessário bloqueia emissão sem inventar zero;
- HeroUI, `no-store`, auth/origin/capability server-side e nenhum storage acadêmico no browser.

## PDF

Download/impressão só aparecem para emissão ou reimpressão. `bulletin-pdf-actions-v2.ts` carrega o renderer V2 por `import()`; o renderer recebe exclusivamente `RelationalBulletinSnapshotV2` e reutiliza o envelope raster limitado/Geist do V1. Não há endpoint adicional, recálculo, fonte remota ou persistência no navegador. Um documento é produzido por vez.

Contrato operacional e gates: [`docs/gradebook/RELATIONAL_BULLETINS_V2.md`](../../../../docs/gradebook/RELATIONAL_BULLETINS_V2.md).

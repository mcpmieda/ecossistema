-- The Conselho keeps only its current state (owner decision 23/11/2026, BN-DEC-049, #1558): no timeline, no
-- closure snapshots and no record of what a decision or a count was before. What stays is the session
-- (state and version), each student's current decision and count, and the idempotency keys.
-- Dropped: the session, decision and count histories (0003, and conselho_decisao_historico from 0001),
-- the closure snapshots with their items (0003) and the session's pointer to its last snapshot. No view,
-- function or trigger depends on them and no other module reads them. Their rows are discarded with them
-- (authorized by the owner; production had none on 23/11/2026). Earlier migrations that mention them stay
-- as applied history. Apply after the code that no longer reads or writes them is published.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE gradebook.conselho_sessao DROP COLUMN fechamento_atual_id;
DROP TABLE
  gradebook.conselho_fechamento_item,
  gradebook.conselho_fechamento,
  gradebook.conselho_sessao_historico,
  gradebook.conselho_votacao_historico,
  gradebook.conselho_decisao_comando,
  gradebook.conselho_decisao_historico;
COMMIT;

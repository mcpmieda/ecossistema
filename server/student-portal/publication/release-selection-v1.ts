/** Trusted SQL fragments shared by Self, administrative summaries and the inventory.
 * Callers provide SQL expressions from source code, never request text. Aliases p/t are
 * period/current target; account decisions remain bound to their publication class. */
const TARGET_RELEASE_KEYS_V1 = "ARRAY['school:2026','class:2026:'||t.class_id::text,'account:2026:'||t.account_id::text]";
export const SCHOOL_RELEASE_KEYS_V1 = "ARRAY['school:2026']";
export const PARENT_RELEASE_KEYS_V1 = "ARRAY['school:2026',CASE WHEN t.scope_kind='account' THEN 'class:2026:'||t.class_id::text END]";
export function releaseSelectionSqlV1(keys = TARGET_RELEASE_KEYS_V1) {
  return `SELECT release.* FROM student_portal.publication_release_v2 release
    WHERE release.academic_year=2026 AND release.period=p.period
      AND release.scope_key=ANY(${keys})
      AND release.version>COALESCE((to_jsonb(release)->>'inherit_version')::bigint,0)
      AND (release.scope_kind<>'account' OR release.target_revision IS NULL OR release.bound_class_id=t.class_id)
    ORDER BY release.version DESC LIMIT 1`;
}
/** A deliberate return to a parent must not resurrect an origin-less legacy approval.
 * New explicit decisions still win normally; their versions exceed the inheritance marker. */
export const LEGACY_ALLOWED_SQL_V1 = `NOT EXISTS(
  SELECT 1 FROM student_portal.publication_release_v2 inherited
  WHERE inherited.academic_year=2026 AND inherited.period=p.period
    AND inherited.scope_key=ANY(${TARGET_RELEASE_KEYS_V1})
    AND COALESCE((to_jsonb(inherited)->>'inherit_version')::bigint,0)>0
)`;

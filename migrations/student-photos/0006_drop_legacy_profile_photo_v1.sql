-- Removes the SharePoint photo references left by the #1119 cutover (adopted on 25/09/2026).
-- The table has been empty since then; nothing reads it except the checks removed here.
-- Aborts without changing anything if a single row still exists.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM student_portal.profile_photo) THEN
    RAISE EXCEPTION 'profile-photo-not-empty';
  END IF;
END $$;

-- Same function, owner and grants, without the lookup of a legacy reference.
CREATE OR REPLACE FUNCTION student_photos.initialize_family_v1(p_uid uuid, p_actor uuid, p_legacy jsonb, p_asset jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF p_actor IS NULL OR p_uid IS NULL OR p_legacy IS NOT NULL OR p_asset IS NOT NULL
    THEN RAISE EXCEPTION 'photo-context-invalid'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('student-photo:'||p_uid::text,1119));
  IF EXISTS(SELECT 1 FROM student_photos.photo_family_v1 WHERE student_uid=p_uid) THEN RETURN; END IF;
  INSERT INTO student_photos.photo_family_v1(student_uid,assets)
    VALUES(p_uid,jsonb_build_object('portrait',NULL,'avatar',NULL));
END $function$;

-- One-time adoption of the SharePoint originals, and its reader.
DROP FUNCTION student_photos.adopt_storage_photo_v1(uuid, jsonb, jsonb);
DROP FUNCTION student_photos.legacy_reference_v1(uuid);
DROP TABLE student_portal.profile_photo;

COMMIT;

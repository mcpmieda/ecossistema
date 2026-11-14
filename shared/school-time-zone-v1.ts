/**
 * The school's time zone: the only source for every date and time in the code (owner decision
 * 14/11/2026, issue #1426, 41). America/Bahia has been UTC−3 with no daylight saving since 2012; if
 * Brazil brings daylight saving back, the school follows Bahia's rule. SQL reads the same name: the
 * database's default time zone is set to it (migration attendance/0024) and queries that need the
 * school's day use it explicitly.
 */
export const SCHOOL_TIME_ZONE_V1 = 'America/Bahia' as const;
/** The value saved before 14/11/2026 in the Portal's calendar policy; read as SCHOOL_TIME_ZONE_V1. */
export const LEGACY_SCHOOL_TIME_ZONE_V1 = 'America/Sao_Paulo' as const;

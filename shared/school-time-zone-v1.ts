/**
 * The school's time zone: the only source for every date and time in the code. America/Bahia has
 * been UTC−3 with no daylight saving since 2012; if Brazil brings daylight saving back, the school
 * follows Bahia's rule. SQL reads the same name: the database's default time zone is set to it
 * (migration attendance/0024) and queries that need the school's day use it explicitly.
 */
export const SCHOOL_TIME_ZONE_V1 = 'America/Bahia' as const;
/** The value older saves of the Portal's calendar policy hold; read as SCHOOL_TIME_ZONE_V1. */
export const LEGACY_SCHOOL_TIME_ZONE_V1 = 'America/Sao_Paulo' as const;

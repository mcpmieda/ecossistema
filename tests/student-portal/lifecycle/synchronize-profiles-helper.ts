import { z } from 'zod';
import type { StudentPortalPostgresQueryV1 } from '../../../server/student-portal/persistence/postgres-persistence-v1';

const counts = z.object({
  created_count: z.number().int().nonnegative(),
  updated_count: z.number().int().nonnegative(),
  denied_count: z.number().int().nonnegative(),
});

/** Internal operation. Initial population must be explicitly authorized by the caller. */
export class LifecycleServiceV1 {
  constructor(private readonly sql: StudentPortalPostgresQueryV1) {}

  async synchronize(options: { createProfiles: boolean }) {
    z.boolean().parse(options.createProfiles);
    const rows = await this.sql.unsafe(
      'SELECT * FROM student_portal.synchronize_profiles_v1($1::boolean)',
      [options.createProfiles],
    );
    if (rows.length !== 1) throw new Error('student-portal-lifecycle-unavailable');
    const result = counts.parse(rows[0]);
    return { created: result.created_count, updated: result.updated_count, denied: result.denied_count };
  }
}

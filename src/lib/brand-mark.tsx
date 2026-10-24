import { SchoolMarkV1 } from '../shared/brand/school-mark-v1';

/** Institutional mark shared by the browser applications: the school crest (was the "IA" monogram). */
export function BrandMark({ compact = false, pulse = false }: Readonly<{ compact?: boolean; pulse?: boolean }>) {
  return <SchoolMarkV1 size={compact ? 36 : 44} pulse={pulse} />;
}

import { photoImageUrlV1 } from '../../../../shared/student-photos/catalog-v1';
import { LinkedStudentPhotoAvatarV1 } from '../../student-photos/linked-student-photo-avatar-v1';
import './student-avatar-v1.css';

/** The image this avatar asks for, so a list can request its first rows before they mount. */
export function studentAvatarPhotoV1(id: string) {
  const subject = { source: 'portal' as const, academicYear: 2026, accountIds: [id] };
  return { url: photoImageUrlV1(subject, 'avatar'), subject };
}

/** All callers provide a Portal account reference, never a guessed canonical person ID. */
export function StudentAvatarV1({ id, detail = false }: Readonly<{ id: string; detail?: boolean }>) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return <LinkedStudentPhotoAvatarV1 decorative size={detail ? 'lg' : 'sm'} loading={detail ? 'eager' : 'lazy'} fallbackTone={hash % 6} className="pa-student-avatar"
    subject={{ source: 'portal', academicYear: 2026, accountIds: [id] }} />;
}

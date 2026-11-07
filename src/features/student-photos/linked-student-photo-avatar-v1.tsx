import { useEffect, useState } from 'react';
import { photoImageUrlV1, photoSubjectKeyV1 } from '../../../shared/student-photos/catalog-v1';
import { photoAdminSubjectV1, type PhotoAdminSubjectV1 } from '../../../shared/student-photos/admin-http-v1';
import { StudentPhotoAvatarV1, type StudentPhotoAvatarPropsV1 } from './student-photo-avatar-v1';
import { PHOTO_CHANGED_EVENT_V1, type PhotoChangedDetailV1 } from './catalog-client-v1';
import { usePhotoMemoryV1 } from './photo-memory-v1';

interface LinkedStudentPhotoAvatarPropsV1 extends Pick<StudentPhotoAvatarPropsV1, 'size' | 'label' | 'className' | 'decorative' | 'fallbackTone' | 'loading'> {
  subject: PhotoAdminSubjectV1;
  studentUid?: string;
  revision?: string | null;
}
export function LinkedStudentPhotoAvatarV1(props: Readonly<LinkedStudentPhotoAvatarPropsV1>) {
  const parsed = photoAdminSubjectV1.safeParse(props.subject);
  if (!parsed.success) return <StudentPhotoAvatarV1 size={props.size} label={props.label} className={props.className} decorative={props.decorative} fallbackTone={props.fallbackTone} loading={props.loading}
    identityKey={props.studentUid ?? 'unresolved-student'} />;
  return <LinkedAvatarSessionV1 key={photoSubjectKeyV1(parsed.data)} {...props} subject={parsed.data} />;
}
/** Whether the row is on, or about to enter, the screen: its photo downloads before the others. */
function useNearScreenV1(eager: boolean) {
  const [near, setNear] = useState(eager || typeof IntersectionObserver === 'undefined');
  const [node, setNode] = useState<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (near || !node) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setNear(true);
    }, { rootMargin: '600px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [near, node]);
  return [near, setNode] as const;
}
function LinkedAvatarSessionV1({ subject, studentUid, revision, ...props }: Readonly<LinkedStudentPhotoAvatarPropsV1>) {
  const subjectKey = photoSubjectKeyV1(subject);
  const [changed, setChanged] = useState<PhotoChangedDetailV1>();
  useEffect(() => {
    const update = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const value = event.detail as Partial<PhotoChangedDetailV1> | undefined;
      if (value?.subjectKey !== subjectKey && (!studentUid || value?.studentUid !== studentUid)) return;
      if (typeof value?.studentUid !== 'string' || (value.revision !== null && typeof value.revision !== 'string')) return;
      setChanged(value as PhotoChangedDetailV1);
    };
    window.addEventListener(PHOTO_CHANGED_EVENT_V1, update);
    return () => window.removeEventListener(PHOTO_CHANGED_EVENT_V1, update);
  }, [subjectKey, studentUid]);
  const identityKey = changed?.studentUid ?? studentUid ?? subjectKey;
  const currentRevision = changed ? changed.revision : revision;
  const [near, rootRef] = useNearScreenV1(props.loading === 'eager');
  // A current avatar is read together with the others on screen; a given revision is read alone.
  const src = usePhotoMemoryV1(photoImageUrlV1(subject, 'avatar', currentRevision), near, currentRevision ? undefined : subject);
  return <StudentPhotoAvatarV1 {...props} rootRef={rootRef} identityKey={identityKey} photo={src ? { identityKey, src } : undefined} />;
}

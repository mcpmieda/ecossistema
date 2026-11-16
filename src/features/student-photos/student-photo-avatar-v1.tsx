import { useState, type Ref } from 'react';
import { Avatar } from '@heroui/react/avatar';
import { photoFallbackHueV1 } from '../../../shared/student-photos/crop-v1';

export interface StudentPhotoAvatarPropsV1 {
  identityKey: string;
  photo?: { identityKey: string; src: string };
  label?: string;
  decorative?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  fallbackTone?: number;
  /** When a linked avatar downloads its photo; a photo already in memory always paints at once. */
  loading?: 'eager' | 'lazy';
  rootRef?: Ref<HTMLSpanElement>;
}
/** No initials, random-on-render colors, external URLs or implicit fetch per list row. */
export function StudentPhotoAvatarV1({
  identityKey,
  photo,
  label = 'Foto do aluno',
  decorative = false,
  size = 'md',
  className,
  fallbackTone,
  rootRef,
}: Readonly<StudentPhotoAvatarPropsV1>) {
  const [failed, setFailed] = useState<string>();
  const sameOwner = photo?.identityKey.toLowerCase() === identityKey.toLowerCase();
  const candidate = sameOwner ? photo?.src : undefined;
  const imageKey = identityKey.toLowerCase() + ':' + (candidate ?? '');
  const src =
    candidate &&
    imageKey !== failed &&
    (candidate.startsWith('blob:') || candidate.startsWith('/api/'))
      ? candidate
      : undefined;
  const backgroundColor =
    fallbackTone === undefined ? `hsl(${photoFallbackHueV1(identityKey)} 48% 44%)` : undefined;
  // The image covers a fallback that stays underneath, so a photo already in memory shows at once.
  return (
    <Avatar
      ref={rootRef}
      size={size}
      className={className}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
      style={{ backgroundColor, borderRadius: '50%' }}
    >
      <Avatar.Fallback aria-hidden="true" data-tone={fallbackTone} style={{ backgroundColor }}>
        <span />
      </Avatar.Fallback>
      {src ? (
        <img
          key={imageKey}
          className="avatar__image"
          src={src}
          alt=""
          decoding="async"
          style={{ objectFit: 'cover' }}
          onError={() => setFailed(imageKey)}
        />
      ) : null}
    </Avatar>
  );
}

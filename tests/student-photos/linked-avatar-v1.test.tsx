import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { LinkedStudentPhotoAvatarV1 } from '../../src/features/student-photos/linked-student-photo-avatar-v1';
import { StudentAvatarV1 } from '../../src/features/student-portal-admin/shared/student-avatar-v1';
afterEach(cleanup);
it('keeps an unresolved reference as a fallback instead of breaking its enclosing sheet', () => {
  const view = render(
    <LinkedStudentPhotoAvatarV1
      subject={{ source: 'portal', academicYear: 2026, accountIds: ['invalid-reference'] }}
    />,
  );
  expect(screen.getByRole('img', { name: 'Foto do aluno' })).toBeTruthy();
  expect(view.container.querySelector('img')).toBeNull();
});
it('does not change the accessible student name when the decorative avatar is added', () => {
  render(
    <button aria-label="Selecionar aluno">
      <StudentAvatarV1 id="10000000-0000-4000-8000-000000000001" />
      SYNTHETIC STUDENT
    </button>,
  );
  expect(screen.getByRole('button', { name: 'Selecionar aluno' })).toBeTruthy();
  expect(screen.queryByRole('img')).toBeNull();
});

import { useMemo } from 'react';
import { StudentProfileV1 } from '../../features/student-portal/shell/student-shell-v1';
import { StudentPortalWorkspaceV1 } from '../../features/student-portal/workspace/student-workspace-v1';
import { brilliantSealCountV1 } from '../../features/student-portal/grades/brilliant-seal-v1';
import { PortalPagesV3 } from '../../features/student-portal/redesign/portal-pages-v3';
import { FrequencyPageV3 } from '../../features/student-portal/redesign/frequency-page-v3';
import { SchedulePageV3 } from '../../features/student-portal/redesign/schedule-page-v3';
import { createDemoFrequencyClientV3, createDemoScheduleClientV3, REDESIGN_SELF_V3 } from './demo-data-v3';

/*
 * Redesign preview (owner request 20/10/2026): the real Portal pages (PortalPagesV3, the same
 * component the signed-in portal uses) fed with invented data through clients shaped like the
 * real APIs, so the preview needs no session. Delete this folder and redesign-preview.html to undo.
 */
const portrait = new URL('../assets/demo-student-boy.webp', import.meta.url).href;
const frequencyClient = createDemoFrequencyClientV3();
const scheduleClient = createDemoScheduleClientV3();

export function RedesignAppV3() {
  const data = REDESIGN_SELF_V3;
  const seals = brilliantSealCountV1(data.subjects, data.endedPeriods);
  const grades = useMemo(() => <StudentPortalWorkspaceV1 data={data} profile={null} />, [data]);
  const frequency = useMemo(
    () => <FrequencyPageV3 client={frequencyClient} academicYear={data.profile.link.academicYear} />,
    [data],
  );
  const schedule = useMemo(() => <SchedulePageV3 client={scheduleClient} />, []);
  return (
    <PortalPagesV3
      // No onLogout: the preview has no session, so it shows no "Sair" that would do nothing.
      hero={<StudentProfileV1 profile={data.profile} seals={seals} portraitSrc={portrait} />}
      grades={grades}
      frequency={data.showFrequency === true ? frequency : undefined}
      schedule={data.showSchedule === true ? schedule : undefined}
    />
  );
}

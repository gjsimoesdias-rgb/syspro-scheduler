import { useCallback, useMemo } from 'react';
import type { Job, Schedule } from '../types';
import {
  scheduleByJobId as buildByJob, jobLateness, lateReasons, jobScheduleStatus, scheduleShortfall as buildShortfall,
  type JobScheduleStatus,
} from '../utils/scheduleDiagnostics';

/** Memoised schedule diagnostics for the jobs grid (see utils/scheduleDiagnostics). */
export function useScheduleDiagnostics(schedule: Schedule | null | undefined, jobs: Job[]) {
  const scheduleByJobId = useMemo(() => buildByJob(schedule), [schedule]);
  const jobLatenessMap = useMemo(() => jobLateness(schedule, jobs), [schedule, jobs]);
  const lateWhyByJob = useMemo(() => lateReasons(schedule, jobs, jobLatenessMap), [schedule, jobs, jobLatenessMap]);
  const scheduleShortfall = useMemo(() => buildShortfall(schedule, jobs), [schedule, jobs]);
  const getJobScheduleStatus = useCallback(
    (job: Job): JobScheduleStatus => jobScheduleStatus(job, scheduleByJobId),
    [scheduleByJobId],
  );
  return { scheduleByJobId, jobLatenessMap, lateWhyByJob, scheduleShortfall, getJobScheduleStatus };
}

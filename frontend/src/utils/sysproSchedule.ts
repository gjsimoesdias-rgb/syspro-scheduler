/**
 * Build a board schedule from the dates SYSPRO already holds on each job's
 * operations (no engine run) — used when no saved plan exists. Pure; moved
 * from App.tsx (App.tsx split).
 */
import type { Job, Schedule } from '../types';

export function buildScheduleFromSysproJobs(jobs: Job[]): Schedule | null {
  const normalizeMachineValue = (value: unknown): string => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const normalized = normalizeMachineValue(entry);
        if (normalized) return normalized;
      }
      return '';
    }

    const text = String(value ?? '').trim();
    if (!text) return '';
    return text.split(',').map((part) => part.trim()).filter(Boolean)[0] || '';
  };

  const combineSysproDateTime = (dateValue: unknown, timeValue?: unknown): Date | null => {
    if (!dateValue) return null;

    const combined = new Date(dateValue as any);
    if (Number.isNaN(combined.getTime())) return null;

    if (timeValue === undefined || timeValue === null || String(timeValue).trim() === '') {
      return combined;
    }

    const raw = String(timeValue).trim();
    if (raw.includes(':')) {
      const [hours, minutes, seconds] = raw.split(':').map((value) => Number(value) || 0);
      combined.setHours(Math.max(0, Math.min(23, hours)), Math.max(0, Math.min(59, minutes)), Math.max(0, Math.min(59, seconds || 0)), 0);
      return combined;
    }

    const digits = raw.replace(/\D/g, '').padStart(4, '0').slice(-4);
    const hours = Number(digits.slice(0, 2)) || 0;
    const minutes = Number(digits.slice(2, 4)) || 0;
    combined.setHours(Math.max(0, Math.min(23, hours)), Math.max(0, Math.min(59, minutes)), 0, 0);
    return combined;
  };

  const jobSchedules = jobs.map((job) => {
    const operationSchedules = (job.operations || [])
      .map((operation) => {
        const plannedStartDate = combineSysproDateTime(
          operation.plannedStartDate || operation.SchStartDate,
          operation.SchStartTime
        );
        const plannedEndDate = combineSysproDateTime(
          operation.plannedEndDate || operation.SchEndDate,
          operation.SchEndTime
        );
        if (!plannedStartDate || !plannedEndDate) {
          return null;
        }

        if (Number.isNaN(plannedStartDate.getTime()) || Number.isNaN(plannedEndDate.getTime()) || plannedEndDate <= plannedStartDate) {
          return null;
        }

        const setupTime = Math.max(0, Number(operation.setupTime) || 0);
        const runTime = Math.max(0, Number(operation.duration) || 0);
        const queueTime = Math.max(0, Number(operation.queueTime) || 0);
        const moveTime = Math.max(0, Number(operation.moveTime) || 0);
        const setupStart = new Date(plannedStartDate);
        const setupEnd = new Date(plannedStartDate.getTime() + setupTime * 60 * 1000);
        const runStart = new Date(setupEnd);
        const runEnd = new Date(plannedEndDate);

        const bookedDurationMinutes = Math.max(1, setupTime + runTime);

        return {
          opId: operation.opId,
          workcentreId: operation.workcentreId,
          resourceId: normalizeMachineValue(operation.ScheduledMachine)
            || normalizeMachineValue(operation.assignedResourceId)
            || normalizeMachineValue(operation.IMachine)
            || operation.workcentreId,
          plannedStartDate,
          plannedEndDate,
          duration: bookedDurationMinutes,
          setupTime,
          runTime,
          queueTime,
          moveTime,
          setupStart,
          setupEnd,
          runStart,
          runEnd,
          queueEnd: new Date(runEnd),
          moveEnd: new Date(runEnd.getTime() + moveTime * 60 * 1000),
          sequence: Number(operation.sequence) || 0,
          isOvertimeSlot: false,
          batchSize: Number(operation.batchSize) || 1,
          slackTime: 0
        };
      })
      .filter((operation): operation is NonNullable<typeof operation> => !!operation)
      .sort((a, b) => a.sequence - b.sequence || a.plannedStartDate.getTime() - b.plannedStartDate.getTime());

    if (!operationSchedules.length) {
      return null;
    }

    return {
      jobId: job.jobId,
      plannedStartDate: operationSchedules[0].plannedStartDate,
      plannedEndDate: operationSchedules[operationSchedules.length - 1].plannedEndDate,
      operationSchedules,
      estimatedTardiness: 0,
      status: 'Scheduled' as const
    };
  }).filter((jobSchedule): jobSchedule is NonNullable<typeof jobSchedule> => !!jobSchedule);

  if (!jobSchedules.length) {
    return null;
  }

  const startMs = Math.min(...jobSchedules.map((jobSchedule) => jobSchedule.plannedStartDate.getTime()));
  const endMs = Math.max(...jobSchedules.map((jobSchedule) => jobSchedule.plannedEndDate.getTime()));

  return {
    scheduleId: 'syspro-live',
    scheduledDate: new Date(),
    version: 1,
    status: 'Draft',
    planningHorizon: {
      startDate: new Date(startMs),
      endDate: new Date(endMs)
    },
    jobSchedules,
    resourceLoads: [],
    constraintViolations: [],
    metrics: {
      totalJobsScheduled: jobSchedules.length,
      jobsOnTime: jobSchedules.length,
      jobsTardy: 0,
      averageTardiness: 0,
      resourceUtilization: 0,
      overtimeHours: 0,
      criticalPathLength: 0,
      totalSetupTime: 0,
      totalQueueTime: 0,
      totalMoveTime: 0
    }
  };
}

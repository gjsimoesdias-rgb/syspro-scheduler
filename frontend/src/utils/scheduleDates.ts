import { Schedule } from '../types';

/**
 * Re-hydrates all Date fields in a Schedule that arrived from the API as ISO strings.
 * Worker thread serialisation converts Dates to strings; this restores them.
 */
export const convertScheduleDates = (schedule: Schedule): Schedule => {
  return {
    ...schedule,
    scheduledDate: new Date(schedule.scheduledDate),
    planningHorizon: {
      startDate: new Date(schedule.planningHorizon.startDate),
      endDate: new Date(schedule.planningHorizon.endDate)
    },
    jobSchedules: schedule.jobSchedules.map((job) => ({
      ...job,
      plannedStartDate: new Date(job.plannedStartDate),
      plannedEndDate: new Date(job.plannedEndDate),
      operationSchedules: job.operationSchedules.map((op: any) => ({
        ...op,
        plannedStartDate: new Date(op.plannedStartDate),
        plannedEndDate: new Date(op.plannedEndDate),
        setupStart: op.setupStart ? new Date(op.setupStart) : new Date(op.plannedStartDate),
        setupEnd: op.setupEnd ? new Date(op.setupEnd) : new Date(op.plannedStartDate),
        runStart: op.runStart ? new Date(op.runStart) : new Date(op.plannedStartDate),
        runEnd: op.runEnd ? new Date(op.runEnd) : new Date(op.plannedEndDate),
        queueEnd: op.queueEnd ? new Date(op.queueEnd) : new Date(op.plannedEndDate),
        moveEnd: op.moveEnd ? new Date(op.moveEnd) : new Date(op.plannedEndDate),
      }))
    }))
  };
};

import { describe, it, expect } from 'vitest';
import { buildScheduleFromSysproJobs } from './sysproSchedule';

const op = (seq: number, start?: string, end?: string, machine = 'M1, M2'): any => ({
  opId: `J-OP${seq}`, sequence: seq, workcentreId: 'L1', duration: 60, setupTime: 0, queueTime: 0, moveTime: 0,
  plannedStartDate: start, plannedEndDate: end, ScheduledMachine: machine,
});
const job = (id: string, ops: any[]): any => ({ jobId: id, dueDate: new Date('2026-10-10'), operations: ops });

describe('buildScheduleFromSysproJobs', () => {
  it('returns null when no operation carries SYSPRO dates', () => {
    expect(buildScheduleFromSysproJobs([job('A', [op(1)])])).toBeNull();
  });

  it('builds job schedules from dated operations only, first machine of a list', () => {
    const s = buildScheduleFromSysproJobs([
      job('A', [op(2, '2026-10-02T08:00:00', '2026-10-02T10:00:00'), op(1, '2026-10-01T08:00:00', '2026-10-01T09:00:00')]),
      job('B', [op(1)]),
    ])!;
    expect(s.jobSchedules).toHaveLength(1);
    const a = s.jobSchedules[0];
    expect(a.jobId).toBe('A');
    expect(a.operationSchedules.map((o: any) => o.sequence)).toEqual([1, 2]);
    expect(a.operationSchedules[0].resourceId).toBe('M1');
    expect(new Date(a.plannedStartDate).getTime()).toBe(new Date('2026-10-01T08:00:00').getTime());
  });

  it('ignores operations whose end is not after their start', () => {
    expect(buildScheduleFromSysproJobs([job('A', [op(1, '2026-10-01T09:00:00', '2026-10-01T09:00:00')])])).toBeNull();
  });
});

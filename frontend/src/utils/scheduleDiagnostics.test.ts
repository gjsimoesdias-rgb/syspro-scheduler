import { describe, it, expect } from 'vitest';
import { jobLateness, lateReasons, scheduleShortfall, jobScheduleStatus, scheduleByJobId, fmtSpan } from './scheduleDiagnostics';

const job = (id: string, due: string, ops = 1): any => ({
  jobId: id, dueDate: due,
  operations: Array.from({ length: ops }, (_, i) => ({ opId: `${id}-OP${i + 1}`, sequence: i + 1, workcentreId: 'L1', workcentreName: 'Line 1' })),
});
const js = (id: string, end: string, ops: any[] = [{}]): any => ({ jobId: id, plannedEndDate: end, operationSchedules: ops });

describe('scheduleDiagnostics', () => {
  const jobs = [job('A', '2026-10-05T00:00:00Z'), job('B', '2026-10-05T00:00:00Z'), job('C', '2026-10-05T00:00:00Z'), job('D', '2026-10-05T00:00:00Z')];
  const schedule: any = {
    jobSchedules: [
      js('A', '2026-10-06T00:00:00Z', [{ readyAt: '2026-10-01T00:00:00Z', waitMinutes: 1500, waitReason: 'line', blockedBy: ['000123'] }]),
      js('B', '2026-10-04T20:00:00Z'),
      js('C', '2026-10-01T00:00:00Z'),
      js('D', '2026-10-05T00:00:00Z', []), // unscheduled: end = due
    ],
    constraintViolations: [
      { type: 'CapacityExceeded', severity: 'Warning', affectedJobId: 'D', affectedOperationId: 'D-OP1' },
      { type: 'ScheduleDateViolation', severity: 'Info', affectedJobId: 'A', affectedOperationId: 'A-OP1' },
    ],
  };

  it('classifies lateness and skips unscheduled jobs', () => {
    const m = jobLateness(schedule, jobs);
    expect(m.get('A')).toBe('late');
    expect(m.get('B')).toBe('at-risk');
    expect(m.get('C')).toBe('on-time');
    expect(m.has('D')).toBe(false);
  });

  it('explains why a job is late', () => {
    const why = lateReasons(schedule, jobs, jobLateness(schedule, jobs), () => 'DATE');
    expect(why.get('A')).toBe('Finishes 1d 0h after the due date (DATE).\nWaited 1d 1h for busy lines (behind 123).');
    expect(why.has('B')).toBe(false);
  });

  it('counts dropped operations but not Info notes', () => {
    const s = scheduleShortfall(schedule, jobs)!;
    expect(s.opCount).toBe(1);
    expect(s.jobCount).toBe(1);
    expect(s.topWc).toEqual([['Line 1', 1]]);
    expect(s.tipByJob.get('D')).toContain('Op 1 — Line 1 (no capacity in window)');
  });

  it('job schedule status', () => {
    const by = scheduleByJobId(schedule);
    expect(jobScheduleStatus(jobs[0], by)).toBe('scheduled');
    expect(jobScheduleStatus(jobs[3], by)).toBe('not-scheduled');
    expect(jobScheduleStatus(job('A', '', 2), by)).toBe('partial');
    expect(jobScheduleStatus(job('Z', ''), by)).toBe('not-scheduled');
  });

  it('formats spans', () => {
    expect(fmtSpan(45)).toBe('45m');
    expect(fmtSpan(125)).toBe('2h 5m');
    expect(fmtSpan(3000)).toBe('2d 2h');
  });

  it('explains crew waits separately from line waits', () => {
    const sched: any = { jobSchedules: [js('A', '2026-10-06T00:00:00Z', [
      { readyAt: '2026-10-01T00:00:00Z', waitMinutes: 120, waitReason: 'crew', blockedBy: ['B'] },
    ])] };
    const why = lateReasons(sched, [job('A', '2026-10-05T00:00:00Z')], jobLateness(sched, [job('A', '2026-10-05T00:00:00Z')]), () => 'DATE');
    expect(why.get('A')).toContain('Waited 2h 0m for free operators in its crew.');
  });

  it('names crew causes in the unscheduled tip', () => {
    const sched: any = { jobSchedules: [], constraintViolations: [
      { type: 'CapacityExceeded', severity: 'Warning', affectedJobId: 'A', affectedOperationId: 'A-OP1',
        description: 'Operation A-OP1 (seq 1) could not start inside the planning window: the Nut crew (4 operators) is busy on other lines the whole time' },
    ] };
    expect(scheduleShortfall(sched, [job('A', '')])!.tipByJob.get('A')).toContain('(crew busy all window)');
  });
});

import { describe, it, expect } from 'vitest';
import { analyseMachines } from '../machineAnalysis';

const cal24 = { workingDays: [0, 1, 2, 3, 4, 5, 6], shifts: [{ startTime: '00:00', endTime: '24:00' }] };

describe('analyseMachines', () => {
  it('splits a day into setup, run and idle and computes load', () => {
    const d = (h: number) => new Date(2026, 9, 5, h, 0, 0);
    const schedule: any = { jobSchedules: [{ jobId: 'J1', status: 'Scheduled', operationSchedules: [{
      opId: '1', workcentreId: 'LINE1', resourceId: 'M1',
      setupStart: d(8), setupEnd: d(9), runStart: d(9), runEnd: d(15), plannedStartDate: d(8), plannedEndDate: d(15),
    }] }] };
    const resources: any[] = [
      { resourceId: 'M1', worcentreId: 'LINE1', calendar: cal24 },
      { resourceId: 'M2', worcentreId: 'LINE1', calendar: cal24 },
    ];
    const rows = analyseMachines(schedule, resources, new Date(2026, 9, 5), 2);
    const m1 = rows.find((r) => r.machineId === 'M1')!;
    expect(m1.days[0]).toMatchObject({ availMin: 1440, setupMin: 60, runMin: 360, idleMin: 1020, loadPct: 29 });
    expect(m1.days[1].loadPct).toBe(0);
    expect(rows[0].machineId).toBe('M1'); // busiest first
    expect(rows.find((r) => r.machineId === 'M2')!.ops).toBe(0);
  });
});

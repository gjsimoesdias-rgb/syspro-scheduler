import { describe, it, expect } from 'vitest';
import { planJobsFrom, planKeyOf } from '../planJobs';

describe('planJobsFrom', () => {
  it('adds planned dates, none for unschedulable or missing jobs', () => {
    const jobs: any[] = [
      { jobId: 'A', itemCode: 'X', quantity: 5 },
      { jobId: 'B', itemCode: 'Y', quantity: '7' },
      { jobId: 'C', itemCode: 'Z' },
    ];
    const sched: any[] = [
      { jobId: 'A', plannedStartDate: '2026-10-01T00:00:00Z', plannedEndDate: '2026-10-02T00:00:00Z', status: 'Scheduled' },
      { jobId: 'B', plannedStartDate: '2026-10-01T00:00:00Z', plannedEndDate: '2026-10-02T00:00:00Z', status: 'Unschedulable' },
    ];
    const out = planJobsFrom(jobs, sched);
    expect(out).toEqual([
      { jobId: 'A', itemCode: 'X', quantity: 5, start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' },
      { jobId: 'B', itemCode: 'Y', quantity: 7, start: null, end: null },
      { jobId: 'C', itemCode: 'Z', quantity: 0, start: null, end: null },
    ]);
    expect(planKeyOf(out)).toBe('A|2026-10-01T00:00:00.000Z|2026-10-02T00:00:00.000Z;B|null|null;C|null|null');
  });
});

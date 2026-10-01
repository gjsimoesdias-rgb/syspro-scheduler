/** Explainability: each operation records when it was ready and why it waited. */
import { SchedulingEngine } from '../SchedulingEngine';

const cal = (days: number[]) => ({
  calendarId: 'c', name: 'c', workingDays: days, workingHoursPerDay: 24,
  shifts: [{ shiftId: 's', name: 's', startTime: '00:00', endTime: '24:00', breakTime: 0,
    diversions: [{ id: 'p', type: 'Production', startTime: '00:00', endTime: '24:00', schedulable: true }] }],
  holidays: [],
});
const job = (id: string, dueDay: number, run: number) => ({
  jobId: id, itemCode: id, description: '', quantity: 1, releaseDate: new Date(2026, 9, 3), dueDate: new Date(2026, 9, dueDay),
  priority: 5, status: 'Released', estimatedMaterialCost: 0, estimatedLaborCost: 0,
  operations: [{ opId: `${id}-OP10`, jobId: id, sequence: 10, workcentreId: 'L1', workcentreName: 'L1', duration: run,
    setupTime: 0, queueTime: 0, moveTime: 0, batchSize: 1, qualifiedResourceIds: ['R1'], status: 'NotStarted' }],
});
const ctx = (jobs: any[], calendar: any, start: Date) => ({
  jobs,
  workcentres: new Map([['L1', { worcentreId: 'L1', name: 'L1', description: '', capabilities: [],
    shiftProfile: { name: 's', shifts: [], weeksPerCycle: 1 }, calendar, costPerHour: 0, maxOvertimePerDay: 3 }]]),
  resources: new Map([['R1', { resourceId: 'R1', name: 'R1', type: 'Machine', worcentreId: 'L1', skillTags: [], costPerHour: 0, calendar, status: 'Available' }]]),
  materials: new Map(), planningHorizonStart: start, planningHorizonEnd: new Date(2026, 9, 20),
  schedulingRule: 'edd', schedulingDirection: 'forward',
  resourceCapacities: new Map([['R1', 1]]), workcentreCapacities: new Map([['L1', 1]]),
} as any);

describe('operation wait explanation', () => {
  it('the second job on a busy line waits for the line, blocked by the first', async () => {
    const start = new Date(2026, 9, 5); // Mon 5 Oct
    const s = await new SchedulingEngine().schedule(ctx([job('A', 6, 120), job('B', 7, 60)], cal([0, 1, 2, 3, 4, 5, 6]), start));
    const a = s.jobSchedules.find((j: any) => j.jobId === 'A')!.operationSchedules[0] as any;
    const b = s.jobSchedules.find((j: any) => j.jobId === 'B')!.operationSchedules[0] as any;
    expect(a.waitMinutes).toBe(0);
    expect(b.waitMinutes).toBe(120);
    expect(b.waitReason).toBe('line');
    expect(b.blockedBy).toEqual(['A']);
  });

  it('an op ready on a weekend waits for the calendar', async () => {
    const start = new Date(2026, 9, 3); // Sat 3 Oct, Mon–Fri calendar
    const s = await new SchedulingEngine().schedule(ctx([job('A', 9, 60)], cal([1, 2, 3, 4, 5]), start));
    const a = s.jobSchedules[0].operationSchedules[0] as any;
    expect(a.waitMinutes).toBe(2 * 24 * 60);
    expect(a.waitReason).toBe('calendar');
    expect(a.blockedBy).toBeUndefined();
  });
});

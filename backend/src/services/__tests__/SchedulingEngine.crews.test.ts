/** Crew (labour) pools: lines sharing operators can't all run at once. */
import { SchedulingEngine } from '../SchedulingEngine';
import { crewLookupFrom, normaliseCrewSetup } from '../../utils/crews';

const calendar = {
  calendarId: 'c', name: 'c', workingDays: [0, 1, 2, 3, 4, 5, 6], workingHoursPerDay: 24,
  shifts: [{ shiftId: 's', name: 's', startTime: '00:00', endTime: '24:00', breakTime: 0,
    diversions: [{ id: 'p', type: 'Production', startTime: '00:00', endTime: '24:00', schedulable: true }] }],
  holidays: [],
};
const start = new Date(2026, 9, 5);
const lines = ['L1', 'L2', 'L3'];
const job = (id: string, wc: string, dueDay: number) => ({
  jobId: id, itemCode: id, description: '', quantity: 1, releaseDate: start, dueDate: new Date(2026, 9, dueDay),
  priority: 5, status: 'Released', estimatedMaterialCost: 0, estimatedLaborCost: 0,
  operations: [{ opId: `${id}-OP10`, jobId: id, sequence: 10, workcentreId: wc, workcentreName: wc, duration: 120,
    setupTime: 0, queueTime: 0, moveTime: 0, batchSize: 1, qualifiedResourceIds: [`R-${wc}`], status: 'NotStarted' }],
});
const ctx = (crews: any) => ({
  jobs: [job('A', 'L1', 6), job('B', 'L2', 7), job('C', 'L3', 8)],
  workcentres: new Map(lines.map((wc) => [wc, { worcentreId: wc, name: wc, description: '', capabilities: [],
    shiftProfile: { name: 's', shifts: [], weeksPerCycle: 1 }, calendar, costPerHour: 0, maxOvertimePerDay: 3 }])),
  resources: new Map(lines.map((wc) => [`R-${wc}`, { resourceId: `R-${wc}`, name: wc, type: 'Machine', worcentreId: wc, skillTags: [], costPerHour: 0, calendar, status: 'Available' }])),
  materials: new Map(), planningHorizonStart: start, planningHorizonEnd: new Date(2026, 9, 20),
  schedulingRule: 'edd', schedulingDirection: 'forward',
  resourceCapacities: new Map(lines.map((wc) => [`R-${wc}`, 1])), workcentreCapacities: new Map(lines.map((wc) => [wc, 1])),
  crews,
} as any);
const crewOf = (headcount: number, enabled = true) => crewLookupFrom(normaliseCrewSetup({
  enabled, pools: [{ name: 'Packing', headcount }],
  lines: Object.fromEntries(lines.map((wc) => [wc, { poolId: 'packing', operators: 3 }])),
}) as any);
const startOf = (s: any, id: string) => +new Date(s.jobSchedules.find((j: any) => j.jobId === id).operationSchedules[0].plannedStartDate) - +start;
const H = 3600_000;

describe('crew pools', () => {
  it('without crews all three lines start together', async () => {
    const s = await new SchedulingEngine().schedule(ctx(undefined));
    expect(['A', 'B', 'C'].map((id) => startOf(s, id))).toEqual([0, 0, 0]);
  });

  it('a crew of 6 runs two 3-operator lines; the third waits for crew', async () => {
    const s = await new SchedulingEngine().schedule(ctx(crewOf(6)));
    expect(startOf(s, 'A')).toBe(0);
    expect(startOf(s, 'B')).toBe(0);
    expect(startOf(s, 'C')).toBe(2 * H);
    const c = s.jobSchedules.find((j: any) => j.jobId === 'C')!.operationSchedules[0] as any;
    expect(c.waitReason).toBe('crew');
    expect(c.waitMinutes).toBe(120);
    expect(c.blockedBy.sort()).toEqual(['A', 'B']);
  });

  it('disabled crews have no effect', async () => {
    expect(crewOf(6, false)).toBeUndefined();
  });

  it('a line needing more operators than the crew has is reported, not scheduled', async () => {
    const s = await new SchedulingEngine().schedule(ctx(crewOf(2)));
    const msgs = s.constraintViolations.map((v: any) => v.description).join('\n');
    expect(msgs).toMatch(/needs 3 operators on L1 but the Packing crew has only 2/);
    expect(s.jobSchedules.every((j: any) => j.operationSchedules.length === 0)).toBe(true);
  });

  it('says when the crew was busy for the whole window', async () => {
    const c = ctx(crewOf(3)); // one 3-operator line at a time
    c.planningHorizonEnd = new Date(2026, 9, 5, 1, 0); // 1-hour window
    c.ruleToggles = { allowFinishAfterHorizon: true };
    const s = await new SchedulingEngine().schedule(c);
    expect(s.jobSchedules.find((j: any) => j.jobId === 'A')!.operationSchedules).toHaveLength(1);
    const msgs = s.constraintViolations.filter((v: any) => v.affectedJobId === 'B').map((v: any) => v.description).join('\n');
    expect(msgs).toMatch(/could not start inside the planning window: the Packing crew \(3 operators\) is busy/);
  });
});

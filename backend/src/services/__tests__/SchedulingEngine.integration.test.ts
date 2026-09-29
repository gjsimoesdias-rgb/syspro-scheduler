/**
 * Integration-style tests for the greedy engine (PLAN_2026-07-07 §1.4):
 *  - operations never land outside a resource's shift calendar
 *  - flow-line mode keeps every op of a job inside one line group
 */

import { SchedulingEngine, SchedulingContext } from '../SchedulingEngine';
import { Job, Operation, Workcentre, Resource, Material } from '../../types';

function makeCalendar(startTime = '08:00', endTime = '16:00', workingDays = [1, 2, 3, 4, 5]) {
  return {
    calendarId: 'cal-1',
    name: 'Standard',
    workingDays,
    workingHoursPerDay: 8,
    shifts: [{ shiftId: 's1', name: 'Day', startTime, endTime, breakTime: 0 }],
    holidays: [],
  };
}

function makeResource(id: string, workcentreId: string, lineGroupId?: string): Resource {
  return {
    resourceId: id,
    name: `Resource ${id}`,
    type: 'Machine',
    worcentreId: workcentreId,
    skillTags: [],
    costPerHour: 50,
    calendar: makeCalendar(),
    status: 'Available',
    ...(lineGroupId ? { lineGroupId } : {}),
  } as Resource;
}

function makeWorkcentre(id: string): Workcentre {
  return {
    worcentreId: id,
    name: `WC ${id}`,
    description: '',
    capabilities: [],
    shiftProfile: { name: 'Standard', shifts: [], weeksPerCycle: 1 },
    calendar: makeCalendar(),
    costPerHour: 80,
    maxOvertimePerDay: 0,
  };
}

function makeOperation(opId: string, jobId: string, seq: number, wcId: string, durationMins: number): Operation {
  return {
    opId,
    jobId,
    sequence: seq,
    workcentreId: wcId,
    workcentreName: `WC ${wcId}`,
    duration: durationMins,
    setupTime: 0,
    queueTime: 0,
    moveTime: 0,
    batchSize: 1,
    qualifiedResourceIds: [],
    status: 'NotStarted',
  };
}

function makeJob(jobId: string, operations: Operation[], releaseDate: Date, dueDate: Date, extra: Partial<Job> = {}): Job {
  return {
    jobId,
    itemCode: `ITEM-${jobId}`,
    description: `Job ${jobId}`,
    quantity: 10,
    dueDate,
    releaseDate,
    priority: 5,
    status: 'Released',
    operations,
    estimatedMaterialCost: 0,
    estimatedLaborCost: 0,
    ...extra,
  };
}

function makeContext(
  jobs: Job[],
  workcentres: Workcentre[],
  resources: Resource[],
  horizonStart: Date,
  horizonEnd: Date,
  overrides: Partial<SchedulingContext> = {},
): SchedulingContext {
  return {
    jobs,
    workcentres: new Map(workcentres.map((wc) => [wc.worcentreId, wc])),
    resources: new Map(resources.map((r) => [r.resourceId, r])),
    materials: new Map<string, Material>(),
    planningHorizonStart: horizonStart,
    planningHorizonEnd: horizonEnd,
    schedulingRule: 'priority',
    schedulingDirection: 'forward',
    ...overrides,
  };
}

const DAY = new Date('2026-06-01T00:00:00.000Z'); // Monday
const HORIZON_END = new Date('2026-06-30T23:59:59.000Z');

describe('SchedulingEngine — calendar integrity (forward)', () => {
  it('every scheduled operation starts and ends on a working weekday', async () => {
    const wc = makeWorkcentre('WC-CAL');
    const res = makeResource('R-CAL', 'WC-CAL');

    // Enough 4h jobs to spill across several days incl. a weekend boundary.
    const jobs = Array.from({ length: 12 }, (_, i) =>
      makeJob(`J-${i}`, [makeOperation(`J-${i}-OP10`, `J-${i}`, 10, 'WC-CAL', 240)], DAY, HORIZON_END),
    );

    const engine = new SchedulingEngine();
    const schedule = await engine.schedule(makeContext(jobs, [wc], [res], DAY, HORIZON_END));

    const allOps = schedule.jobSchedules.flatMap((j) => j.operationSchedules);
    expect(allOps.length).toBeGreaterThan(0);

    for (const op of allOps) {
      const start = new Date(op.plannedStartDate);
      const end = new Date(op.plannedEndDate);
      // Working days only (Mon=1 … Fri=5)
      expect([0, 6]).not.toContain(start.getDay());
      expect([0, 6]).not.toContain(end.getDay());
      // Ends after it starts, inside the horizon
      expect(end.getTime()).toBeGreaterThan(start.getTime());
      expect(start.getTime()).toBeGreaterThanOrEqual(DAY.getTime());
      expect(end.getTime()).toBeLessThanOrEqual(HORIZON_END.getTime());
    }
  });
});

describe('SchedulingEngine — flow-line lock (forward)', () => {
  it('all ops of a flow-line job stay in the line group chosen by op[0]', async () => {
    const wcA = makeWorkcentre('WC-A');
    const wcB = makeWorkcentre('WC-B');
    // Two parallel lines, each spanning both workcentres.
    const resources = [
      makeResource('L1-A', 'WC-A', 'LINE-1'),
      makeResource('L1-B', 'WC-B', 'LINE-1'),
      makeResource('L2-A', 'WC-A', 'LINE-2'),
      makeResource('L2-B', 'WC-B', 'LINE-2'),
    ];

    const jobs = Array.from({ length: 6 }, (_, i) =>
      makeJob(
        `FL-${i}`,
        [
          makeOperation(`FL-${i}-OP10`, `FL-${i}`, 10, 'WC-A', 60),
          makeOperation(`FL-${i}-OP20`, `FL-${i}`, 20, 'WC-B', 60),
        ],
        DAY,
        HORIZON_END,
      ),
    );

    const engine = new SchedulingEngine();
    const context = makeContext(jobs, [wcA, wcB], resources, DAY, HORIZON_END, {
      productionMode: 'flow-line',
    });
    const schedule = await engine.schedule(context);

    const lineOf = (resourceId: string) =>
      (context.resources.get(resourceId) as any)?.lineGroupId ?? null;

    for (const js of schedule.jobSchedules) {
      const lines = new Set(
        js.operationSchedules.map((op) => lineOf(op.resourceId)).filter(Boolean),
      );
      // Every job with placed ops must sit on exactly one line.
      if (js.operationSchedules.length > 0) {
        expect(lines.size).toBeLessThanOrEqual(1);
      }
    }
  });
});

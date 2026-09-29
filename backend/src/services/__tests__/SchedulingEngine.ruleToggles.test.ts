/**
 * Company rule toggles (Settings → FCS → Scheduling Rules):
 * useQueueTime / useSetupTime / useMoveTime = false must remove that time
 * component from the run. Until 2026-07-08 these settings persisted but did
 * nothing.
 */

import { SchedulingEngine, SchedulingContext } from '../SchedulingEngine';
import { Job, Operation, Workcentre, Resource, Material } from '../../types';

function makeCalendar() {
  return {
    calendarId: 'cal-1',
    name: 'Standard',
    workingDays: [1, 2, 3, 4, 5],
    workingHoursPerDay: 8,
    shifts: [{ shiftId: 's1', name: 'Day', startTime: '08:00', endTime: '16:00', breakTime: 0 }],
    holidays: [],
  };
}

function makeResource(id: string, workcentreId: string): Resource {
  return {
    resourceId: id,
    name: `Resource ${id}`,
    type: 'Machine',
    worcentreId: workcentreId,
    skillTags: [],
    costPerHour: 50,
    calendar: makeCalendar(),
    status: 'Available',
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

function makeOperation(
  opId: string, jobId: string, seq: number, wcId: string,
  durationMins: number, setup = 0, queue = 0, move = 0,
): Operation {
  return {
    opId,
    jobId,
    sequence: seq,
    workcentreId: wcId,
    workcentreName: `WC ${wcId}`,
    duration: durationMins,
    setupTime: setup,
    queueTime: queue,
    moveTime: move,
    batchSize: 1,
    qualifiedResourceIds: [],
    status: 'NotStarted',
  };
}

function makeJob(jobId: string, operations: Operation[]): Job {
  return {
    jobId,
    itemCode: `ITEM-${jobId}`,
    description: `Job ${jobId}`,
    quantity: 10,
    dueDate: new Date('2026-06-30T16:00:00.000Z'),
    releaseDate: new Date('2026-06-01T08:00:00.000Z'),
    priority: 5,
    status: 'Released',
    operations,
    estimatedMaterialCost: 0,
    estimatedLaborCost: 0,
  };
}

function makeContext(jobs: Job[], overrides: Partial<SchedulingContext> = {}): SchedulingContext {
  const wcA = makeWorkcentre('WC-A');
  const wcB = makeWorkcentre('WC-B');
  return {
    jobs,
    workcentres: new Map([['WC-A', wcA], ['WC-B', wcB]]),
    resources: new Map([
      ['R-A', makeResource('R-A', 'WC-A')],
      ['R-B', makeResource('R-B', 'WC-B')],
    ]),
    materials: new Map<string, Material>(),
    planningHorizonStart: new Date('2026-06-01T08:00:00.000Z'),
    planningHorizonEnd: new Date('2026-06-30T16:00:00.000Z'),
    schedulingRule: 'priority',
    schedulingDirection: 'forward',
    ...overrides,
  };
}

/** Two-op job with generous queue/setup/move so toggle effects are visible. */
function twoOpJob(): Job {
  return makeJob('J1', [
    makeOperation('J1-OP10', 'J1', 10, 'WC-A', 60, 30, 45, 30),
    makeOperation('J1-OP20', 'J1', 20, 'WC-B', 60, 30, 45, 30),
  ]);
}

async function jobSpanMinutes(ctx: SchedulingContext): Promise<number> {
  const engine = new SchedulingEngine();
  const schedule = await engine.schedule(ctx);
  const js = schedule.jobSchedules[0];
  expect(js.operationSchedules.length).toBe(2);
  return (new Date(js.plannedEndDate).getTime() - new Date(js.plannedStartDate).getTime()) / 60000;
}

describe('SchedulingEngine — company rule toggles', () => {
  it('disabling all three components produces a strictly shorter job span', async () => {
    const spanAllOn = await jobSpanMinutes(makeContext([twoOpJob()]));
    const spanAllOff = await jobSpanMinutes(
      makeContext([twoOpJob()], {
        ruleToggles: { useQueueTime: false, useSetupTime: false, useMoveTime: false },
      }),
    );
    expect(spanAllOff).toBeLessThan(spanAllOn);
  });

  it('useSetupTime=false removes setup from the scheduled operations', async () => {
    const engine = new SchedulingEngine();
    const schedule = await engine.schedule(
      makeContext([twoOpJob()], { ruleToggles: { useSetupTime: false } }),
    );
    for (const op of schedule.jobSchedules[0].operationSchedules) {
      expect(op.setupTime).toBe(0);
    }
  });

  it('useQueueTime=false removes the queue lag before each operation', async () => {
    const spanQueueOn = await jobSpanMinutes(makeContext([twoOpJob()]));
    const spanQueueOff = await jobSpanMinutes(
      makeContext([twoOpJob()], { ruleToggles: { useQueueTime: false } }),
    );
    expect(spanQueueOff).toBeLessThan(spanQueueOn);
  });

  it('useMoveTime=false removes move time from the scheduled operations', async () => {
    const engine = new SchedulingEngine();
    const schedule = await engine.schedule(
      makeContext([twoOpJob()], { ruleToggles: { useMoveTime: false } }),
    );
    for (const op of schedule.jobSchedules[0].operationSchedules) {
      expect(op.moveTime).toBe(0);
    }
  });

  it('all-true toggles behave identically to no toggles at all', async () => {
    const spanDefault = await jobSpanMinutes(makeContext([twoOpJob()]));
    const spanExplicit = await jobSpanMinutes(
      makeContext([twoOpJob()], {
        ruleToggles: { useQueueTime: true, useSetupTime: true, useMoveTime: true },
      }),
    );
    expect(spanExplicit).toBe(spanDefault);
  });

  it('backward direction also honours the toggles', async () => {
    const spanOn = await jobSpanMinutes(
      makeContext([twoOpJob()], { schedulingDirection: 'backward' }),
    );
    const spanOff = await jobSpanMinutes(
      makeContext([twoOpJob()], {
        schedulingDirection: 'backward',
        ruleToggles: { useQueueTime: false, useSetupTime: false, useMoveTime: false },
      }),
    );
    expect(spanOff).toBeLessThan(spanOn);
  });
});

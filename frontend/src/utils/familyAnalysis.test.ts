/**
 * familyAnalysis — master/sub family tree analysis for the Job Tree tab.
 */
import { describe, it, expect } from 'vitest';
import { analyzeFamily, listFamilyRoots } from './familyAnalysis';
import { buildParentMap } from './masterSub';
import type { Job, Schedule } from '../types';

const makeOp = (opId: string, wc: string, durationMin: number, setupMin = 0) => ({
  opId,
  jobId: '',
  sequence: 1,
  workcentreId: wc,
  workcentreName: wc,
  duration: durationMin,
  setupTime: setupMin,
  queueTime: 0,
  moveTime: 0,
  batchSize: 1,
});

const makeJob = (jobId: string, extra: Record<string, unknown> = {}): Job =>
  ({
    jobId,
    itemCode: `ITEM-${jobId}`,
    description: '',
    quantity: 1,
    dueDate: new Date('2026-08-01T16:00:00'),
    releaseDate: new Date('2026-07-01T08:00:00'),
    priority: 5,
    status: 'Released',
    operations: [],
    ...extra,
  } as unknown as Job);

const makeSchedule = (entries: Array<{ jobId: string; start: string; end: string; ops?: number }>): Schedule =>
  ({
    scheduleId: 's1',
    scheduledDate: new Date(),
    version: 1,
    status: 'Draft',
    planningHorizon: { startDate: new Date('2026-07-01'), endDate: new Date('2026-09-01') },
    jobSchedules: entries.map((e) => ({
      jobId: e.jobId,
      plannedStartDate: new Date(e.start),
      plannedEndDate: new Date(e.end),
      operationSchedules: Array.from({ length: e.ops ?? 1 }).map((_, i) => ({ opId: `${e.jobId}-OP${i + 1}` })),
      estimatedTardiness: 0,
      status: 'Scheduled',
    })),
    resourceLoads: [],
    constraintViolations: [],
    metrics: {} as Schedule['metrics'],
  } as unknown as Schedule);

// A family: MST-1 with subs SUB-A (long, late) and SUB-B (short).
const family = () => {
  const master = makeJob('MST-1', {
    operations: [makeOp('MST-1-OP1', 'WC-ASSY', 120)],
    dueDate: new Date('2026-07-20T16:00:00'),
  });
  const subA = makeJob('SUB-A', {
    masterJobId: 'MST-1',
    operations: [makeOp('SUB-A-OP1', 'WC-MILL', 600, 60), makeOp('SUB-A-OP2', 'WC-PAINT', 120)],
  });
  const subB = makeJob('SUB-B', {
    masterJobId: 'MST-1',
    operations: [makeOp('SUB-B-OP1', 'WC-MILL', 90)],
  });
  return [master, subA, subB];
};

describe('listFamilyRoots', () => {
  it('lists top-level masters only (nested masters stay inside the tree)', () => {
    const jobs = [
      ...family(),
      makeJob('NEST-1', { masterJobId: 'SUB-A' }), // SUB-A is a master too, but not a root
      makeJob('LONER'),
    ];
    const roots = listFamilyRoots(jobs, buildParentMap(jobs));
    expect(roots).toEqual(['MST-1']);
  });

  it('treats a master with an unloaded parent as a root', () => {
    const jobs = [makeJob('SUB-X', { masterJobId: 'GHOST-ROOT' })];
    const roots = listFamilyRoots(jobs, buildParentMap(jobs));
    expect(roots).toEqual(['GHOST-ROOT']);
  });
});

describe('analyzeFamily', () => {
  it('builds the tree with per-job KPIs and family totals', () => {
    const jobs = family();
    const fam = analyzeFamily('MST-1', jobs, buildParentMap(jobs), null);

    expect(fam.jobCount).toBe(3);
    expect(fam.root.jobId).toBe('MST-1');
    expect(fam.root.children.map((c) => c.jobId).sort()).toEqual(['SUB-A', 'SUB-B']);
    // Total work: 120 + (660 + 120) + 90 minutes
    expect(fam.totalWorkMinutes).toBe(990);
    // Unscheduled jobs fall back to SYSPRO dates
    expect(fam.root.dateSource).toBe('syspro');
  });

  it('identifies the gating sub-job (latest end) as the bottleneck', () => {
    const jobs = family();
    const schedule = makeSchedule([
      { jobId: 'MST-1', start: '2026-07-18T08:00:00', end: '2026-07-19T16:00:00' },
      { jobId: 'SUB-A', start: '2026-07-10T08:00:00', end: '2026-07-16T16:00:00' },
      { jobId: 'SUB-B', start: '2026-07-10T08:00:00', end: '2026-07-11T12:00:00' },
    ]);
    const fam = analyzeFamily('MST-1', jobs, buildParentMap(jobs), schedule);

    expect(fam.bottleneckJobId).toBe('SUB-A');
    // Slack: master start (18th 08:00) − SUB-A end (16th 16:00) > 0 → no violation
    expect(fam.bottleneckSlackMs).toBe(
      new Date('2026-07-18T08:00:00').getTime() - new Date('2026-07-16T16:00:00').getTime()
    );
    expect(fam.violations).toHaveLength(0);
    // Critical chain marked on root + gating child only
    const subA = fam.root.children.find((c) => c.jobId === 'SUB-A')!;
    const subB = fam.root.children.find((c) => c.jobId === 'SUB-B')!;
    expect(subA.onCriticalChain).toBe(true);
    expect(subA.isGatingJob).toBe(true);
    expect(subB.onCriticalChain).toBe(false);
  });

  it('finds the bottleneck operation on the critical chain', () => {
    const jobs = family();
    const fam = analyzeFamily('MST-1', jobs, buildParentMap(jobs), null);

    // SUB-A gates (most work when undated); its OP1 (600+60m) beats everything.
    expect(fam.bottleneckOp).toEqual({
      jobId: 'SUB-A',
      opId: 'SUB-A-OP1',
      workcentreId: 'WC-MILL',
      minutes: 660,
    });
    expect(fam.topWorkcentre).toEqual({ workcentreId: 'WC-MILL', minutes: 750 });
  });

  it('reports precedence violations when a sub ends after the master starts', () => {
    const jobs = family();
    const schedule = makeSchedule([
      { jobId: 'MST-1', start: '2026-07-12T08:00:00', end: '2026-07-13T16:00:00' },
      { jobId: 'SUB-A', start: '2026-07-10T08:00:00', end: '2026-07-14T16:00:00' }, // overruns
      { jobId: 'SUB-B', start: '2026-07-10T08:00:00', end: '2026-07-11T12:00:00' },
    ]);
    const fam = analyzeFamily('MST-1', jobs, buildParentMap(jobs), schedule);

    expect(fam.violations).toEqual([
      {
        subId: 'SUB-A',
        masterId: 'MST-1',
        overlapMs: new Date('2026-07-14T16:00:00').getTime() - new Date('2026-07-12T08:00:00').getTime(),
      },
    ]);
    expect(fam.bottleneckSlackMs).toBeLessThan(0);
  });

  it('computes master lateness vs the SYSPRO due date', () => {
    const jobs = family(); // master due 2026-07-20 16:00
    const schedule = makeSchedule([
      { jobId: 'MST-1', start: '2026-07-21T08:00:00', end: '2026-07-22T16:00:00' },
    ]);
    const fam = analyzeFamily('MST-1', jobs, buildParentMap(jobs), schedule);

    expect(fam.masterLatenessMs).toBe(
      new Date('2026-07-22T16:00:00').getTime() - new Date('2026-07-20T16:00:00').getTime()
    );
  });

  it('handles nested hierarchies and ghost masters without crashing', () => {
    const jobs = [
      ...family(),
      makeJob('NEST-1', { masterJobId: 'SUB-A', operations: [makeOp('NEST-1-OP1', 'WC-CUT', 2000)] }),
    ];
    const fam = analyzeFamily('MST-1', jobs, buildParentMap(jobs), null);

    const subA = fam.root.children.find((c) => c.jobId === 'SUB-A')!;
    expect(subA.children.map((c) => c.jobId)).toEqual(['NEST-1']);
    expect(fam.jobCount).toBe(4);
    // NEST-1's giant op sits on the critical chain (SUB-A gates, NEST-1 gates SUB-A)
    expect(fam.bottleneckOp?.opId).toBe('NEST-1-OP1');

    // Ghost master root (not loaded) still yields a tree
    const ghostJobs = [makeJob('SUB-X', { masterJobId: 'GHOST-1' })];
    const ghostFam = analyzeFamily('GHOST-1', ghostJobs, buildParentMap(ghostJobs), null);
    expect(ghostFam.root.job).toBeNull();
    expect(ghostFam.root.children[0].jobId).toBe('SUB-X');
  });
});

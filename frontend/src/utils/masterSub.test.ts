/**
 * masterSub — master/sub-job dependency helpers used by manual scheduling
 * (drag & drop guards) and the Gantt dependency visuals.
 */
import { describe, it, expect } from 'vitest';
import {
  buildParentMap,
  canonicalJobKey,
  clampMasterDropStart,
  describeDependencyViolation,
  getDirectSubJobIds,
  getMasterRootJobId,
} from './masterSub';
import type { Job, Schedule } from '../types';

const makeJob = (jobId: string, extra: Record<string, unknown> = {}): Job =>
  ({ jobId, itemCode: 'X', description: '', quantity: 1, dueDate: new Date(), releaseDate: new Date(), priority: 5, status: 'Released', operations: [], ...extra } as unknown as Job);

const makeSchedule = (entries: Array<{ jobId: string; start: string; end: string }>): Schedule =>
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
      operationSchedules: [],
      estimatedTardiness: 0,
      status: 'Scheduled',
    })),
    resourceLoads: [],
    constraintViolations: [],
    metrics: {} as Schedule['metrics'],
  } as unknown as Schedule);

describe('canonicalJobKey', () => {
  it('strips leading zeros from numeric ids and trims text', () => {
    expect(canonicalJobKey('000000000012345')).toBe('12345');
    expect(canonicalJobKey('  MST-1  ')).toBe('MST-1');
  });
});

describe('buildParentMap', () => {
  it('resolves padded/unpadded master links to the exact loaded jobId', () => {
    const master = makeJob('000000000012345');
    const sub = makeJob('000000000067890', { masterJobId: '12345' });
    const map = buildParentMap([master, sub]);

    expect(map.get('000000000067890')).toBe('000000000012345');
  });

  it('skips non-link tokens and self references', () => {
    const jobs = [
      makeJob('A', { masterJobId: 'NONE' }),
      makeJob('B', { masterJobId: 'M' }),
      makeJob('C', { masterJobId: 'C' }),
    ];
    expect(buildParentMap(jobs).size).toBe(0);
  });

  it('keeps unresolved links (master not loaded) for grouping', () => {
    const sub = makeJob('SUB-1', { masterJobId: 'GHOST-1' });
    expect(buildParentMap([sub]).get('SUB-1')).toBe('GHOST-1');
  });
});

describe('getMasterRootJobId / getDirectSubJobIds', () => {
  const map = new Map<string, string>([
    ['LEAF', 'MID'],
    ['MID', 'ROOT'],
    ['OTHER', 'ROOT'],
  ]);

  it('walks nested hierarchies to the root', () => {
    expect(getMasterRootJobId('LEAF', map)).toBe('ROOT');
    expect(getMasterRootJobId('ROOT', map)).toBe('ROOT');
  });

  it('is cycle-safe', () => {
    const cyclic = new Map([['A', 'B'], ['B', 'A']]);
    expect(getMasterRootJobId('A', cyclic)).toBe('B');
  });

  it('lists direct sub-jobs only', () => {
    expect(getDirectSubJobIds('ROOT', map).sort()).toEqual(['MID', 'OTHER']);
    expect(getDirectSubJobIds('MID', map)).toEqual(['LEAF']);
  });
});

describe('clampMasterDropStart', () => {
  const parentMap = new Map([['SUB-1', 'MST-1'], ['SUB-2', 'MST-1']]);
  const schedule = makeSchedule([
    { jobId: 'SUB-1', start: '2026-07-13T08:00:00', end: '2026-07-14T16:00:00' },
    { jobId: 'SUB-2', start: '2026-07-13T08:00:00', end: '2026-07-16T12:00:00' },
  ]);

  it('clamps a master drop to the latest scheduled sub-job end', () => {
    const early = new Date('2026-07-13T09:00:00').getTime();
    const { clampedStartMs, blockingSubJobId } = clampMasterDropStart('MST-1', early, parentMap, schedule);

    expect(clampedStartMs).toBe(new Date('2026-07-16T12:00:00').getTime());
    expect(blockingSubJobId).toBe('SUB-2');
  });

  it('leaves a drop after all sub-jobs untouched', () => {
    const late = new Date('2026-07-20T08:00:00').getTime();
    const { clampedStartMs, blockingSubJobId } = clampMasterDropStart('MST-1', late, parentMap, schedule);

    expect(clampedStartMs).toBe(late);
    expect(blockingSubJobId).toBeNull();
  });

  it('ignores jobs that are not masters and unscheduled sub-jobs', () => {
    const t = new Date('2026-07-13T09:00:00').getTime();
    expect(clampMasterDropStart('SUB-1', t, parentMap, schedule).blockingSubJobId).toBeNull();
    expect(clampMasterDropStart('MST-1', t, parentMap, makeSchedule([])).blockingSubJobId).toBeNull();
  });
});

describe('describeDependencyViolation', () => {
  const parentMap = new Map([['SUB-1', 'MST-1']]);
  const schedule = makeSchedule([
    { jobId: 'MST-1', start: '2026-07-20T08:00:00', end: '2026-07-22T16:00:00' },
    { jobId: 'SUB-1', start: '2026-07-13T08:00:00', end: '2026-07-14T16:00:00' },
  ]);

  it('warns when a sub-job ends after its master starts', () => {
    const msg = describeDependencyViolation(
      'SUB-1',
      new Date('2026-07-19T08:00:00').getTime(),
      new Date('2026-07-21T08:00:00').getTime(),
      parentMap,
      schedule
    );
    expect(msg).toMatch(/MST-1/);
  });

  it('warns when a master starts before a scheduled sub-job ends', () => {
    const msg = describeDependencyViolation(
      'MST-1',
      new Date('2026-07-14T08:00:00').getTime(),
      new Date('2026-07-16T08:00:00').getTime(),
      parentMap,
      schedule
    );
    expect(msg).toMatch(/SUB-1/);
  });

  it('returns null for a compliant placement', () => {
    const msg = describeDependencyViolation(
      'SUB-1',
      new Date('2026-07-13T08:00:00').getTime(),
      new Date('2026-07-14T16:00:00').getTime(),
      parentMap,
      schedule
    );
    expect(msg).toBeNull();
  });

  it('returns null for jobs with no family links', () => {
    const msg = describeDependencyViolation(
      'LONER',
      new Date('2026-07-13T08:00:00').getTime(),
      new Date('2026-07-14T16:00:00').getTime(),
      parentMap,
      schedule
    );
    expect(msg).toBeNull();
  });
});

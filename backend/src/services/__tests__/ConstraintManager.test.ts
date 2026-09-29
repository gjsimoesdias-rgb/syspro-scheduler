/**
 * Unit tests for ConstraintManager.
 *
 * All pure logic — no DB, no fixtures larger than a handful of objects.
 * Coverage:
 *   - Overtime budget math (per-workcentre rule + env default fallback)
 *   - Movement time matrix (registered values + default fallback)
 *   - Batch rules (no rule, valid range, below min, above max)
 *   - Sequence-dependent setup (registerSetupSequence + loadExternalSequences)
 *   - calculateOperationDuration with and without sequence-aware setup
 */

import ConstraintManager from '../ConstraintManager';
import { Operation, Workcentre } from '../../types';
import environment from '../../config/environment';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorkcentre(id: string, maxOvertimePerDay?: number): Workcentre {
  return {
    worcentreId: id,
    name: `WC ${id}`,
    description: '',
    capabilities: [],
    shiftProfile: { name: 'std', shifts: [], weeksPerCycle: 1 },
    calendar: {
      calendarId: 'cal-1',
      name: 'std',
      workingDays: [1, 2, 3, 4, 5],
      workingHoursPerDay: 8,
      shifts: [],
      holidays: [],
    },
    costPerHour: 80,
    ...(typeof maxOvertimePerDay === 'number' ? { maxOvertimePerDay } : {}),
  } as Workcentre;
}

function makeOp(opId: string, setupTime: number, duration: number, queueTime = 0): Operation {
  return {
    opId,
    jobId: 'J1',
    sequence: 1,
    workcentreId: 'WC-A',
    workcentreName: 'WC-A',
    duration,
    setupTime,
    queueTime,
    moveTime: 0,
    batchSize: 1,
    qualifiedResourceIds: [],
    status: 'NotStarted',
  } as Operation;
}

const newManager = () => {
  const m = new ConstraintManager();
  const wcA = makeWorkcentre('WC-A', 4);
  const wcB = makeWorkcentre('WC-B'); // no per-workcentre rule → env default
  m.initializeConstraints(new Map([['WC-A', wcA], ['WC-B', wcB]]));
  return m;
};

// ---------------------------------------------------------------------------
// Overtime
// ---------------------------------------------------------------------------

describe('ConstraintManager.checkOvertimeConstraint', () => {
  it('uses the per-workcentre maxOvertimePerDay when set', () => {
    const m = newManager();
    const r = m.checkOvertimeConstraint('WC-A', 2, 1.5);
    // 2 + 1.5 = 3.5, budget = 4 → allowed
    expect(r.allowed).toBe(true);
    expect(r.remainingOvertimeHours).toBeCloseTo(2);
  });

  it('rejects when accumulated overtime would breach the budget', () => {
    const m = newManager();
    const r = m.checkOvertimeConstraint('WC-A', 3.5, 1);
    // 3.5 + 1 = 4.5 > 4 → not allowed
    expect(r.allowed).toBe(false);
    expect(r.remainingOvertimeHours).toBeCloseTo(0.5);
  });

  it('falls back to env.maxOvertimePerDay when no rule exists for the workcentre', () => {
    const m = newManager();
    const defaultBudget = environment.maxOvertimePerDay;
    const r = m.checkOvertimeConstraint('WC-B', 0, defaultBudget);
    expect(r.allowed).toBe(true);
    expect(r.remainingOvertimeHours).toBeCloseTo(defaultBudget);
  });

  it('uses env default when the workcentre id is unknown', () => {
    const m = newManager();
    const r = m.checkOvertimeConstraint('UNKNOWN', 0, 0);
    expect(r.allowed).toBe(true);
    expect(r.remainingOvertimeHours).toBeCloseTo(environment.maxOvertimePerDay);
  });

  it('clamps remainingOvertimeHours to zero when already overspent', () => {
    const m = newManager();
    const r = m.checkOvertimeConstraint('WC-A', 99, 0);
    expect(r.remainingOvertimeHours).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Movement matrix
// ---------------------------------------------------------------------------

describe('ConstraintManager.getMovementTime', () => {
  it('returns 0 when the from and to workcentre are the same', () => {
    const m = newManager();
    expect(m.getMovementTime('WC-A', 'WC-A')).toBe(0);
  });

  it('returns the registered value for a known pair', () => {
    const m = newManager();
    m.registerMovementTime('WC-A', 'WC-B', 25);
    expect(m.getMovementTime('WC-A', 'WC-B')).toBe(25);
  });

  it('falls back to environment.defaultMovementTimeMinutes for unknown pairs', () => {
    const m = newManager();
    expect(m.getMovementTime('WC-A', 'WC-B')).toBe(environment.defaultMovementTimeMinutes);
  });

  it('is direction-aware (A->B is not B->A)', () => {
    const m = newManager();
    m.registerMovementTime('WC-A', 'WC-B', 15);
    expect(m.getMovementTime('WC-B', 'WC-A')).toBe(environment.defaultMovementTimeMinutes);
  });
});

// ---------------------------------------------------------------------------
// Batch rules
// ---------------------------------------------------------------------------

describe('ConstraintManager.canBatchOperations', () => {
  it('with no registered rule, accepts qty >= operation.batchSize', () => {
    const m = newManager();
    const op = makeOp('OP1', 10, 30);
    op.batchSize = 5;
    expect(m.canBatchOperations(op, 5, 'ITEM-X')).toEqual({
      canBatch: true,
      batchSize: 5,
    });
  });

  it('with no registered rule, rejects qty < operation.batchSize', () => {
    const m = newManager();
    const op = makeOp('OP1', 10, 30);
    op.batchSize = 5;
    const result = m.canBatchOperations(op, 3, 'ITEM-X');
    expect(result.canBatch).toBe(false);
    expect(result.reason).toContain('below minimum');
  });

  it('rejects qty below the registered minimum', () => {
    const m = newManager();
    m.registerBatchConstraint('ITEM-Y', {
      minimumBatchSize: 10,
      maximumBatchSize: 50,
      setupTimeMinutes: 30,
      itemCode: 'ITEM-Y',
    });
    const op = makeOp('OP1', 10, 30);
    const result = m.canBatchOperations(op, 5, 'ITEM-Y');
    expect(result.canBatch).toBe(false);
    expect(result.reason).toMatch(/below minimum batch size 10/);
  });

  it('rejects qty above the registered maximum', () => {
    const m = newManager();
    m.registerBatchConstraint('ITEM-Y', {
      minimumBatchSize: 10,
      maximumBatchSize: 50,
      setupTimeMinutes: 30,
      itemCode: 'ITEM-Y',
    });
    const op = makeOp('OP1', 10, 30);
    const result = m.canBatchOperations(op, 60, 'ITEM-Y');
    expect(result.canBatch).toBe(false);
    expect(result.reason).toMatch(/exceeds maximum batch size 50/);
  });

  it('accepts a qty inside the registered range', () => {
    const m = newManager();
    m.registerBatchConstraint('ITEM-Y', {
      minimumBatchSize: 10,
      maximumBatchSize: 50,
      setupTimeMinutes: 30,
      itemCode: 'ITEM-Y',
    });
    const op = makeOp('OP1', 10, 30);
    expect(m.canBatchOperations(op, 25, 'ITEM-Y')).toEqual({
      canBatch: true,
      batchSize: 25,
    });
  });
});

// ---------------------------------------------------------------------------
// Sequence-dependent setup
// ---------------------------------------------------------------------------

describe('ConstraintManager.calculateOperationDuration', () => {
  it('uses the registered sequence-aware setup when previousItem→currentItem matches', () => {
    const m = newManager();
    m.registerSetupSequence('WIDGET-A', 'WIDGET-B', 45);
    const op = makeOp('OP1', 10, 30); // operation's own setup is 10
    const total = m.calculateOperationDuration(op, 'WIDGET-A', 'WIDGET-B');
    // 45 (sequence) + 30 (run) + 0 (queue) = 75
    expect(total).toBe(75);
  });

  it('falls back to the operation setupTime when no sequence rule exists', () => {
    const m = newManager();
    const op = makeOp('OP1', 12, 40, 5);
    const total = m.calculateOperationDuration(op, 'X', 'Y');
    // 12 + 40 + 5 = 57
    expect(total).toBe(57);
  });

  it('uses operation.setupTime when previousItem/currentItem are not supplied', () => {
    const m = newManager();
    m.registerSetupSequence('A', 'B', 999); // should be ignored
    const op = makeOp('OP1', 10, 30);
    const total = m.calculateOperationDuration(op);
    expect(total).toBe(40); // 10 + 30
  });
});

// ---------------------------------------------------------------------------
// External sequence loading
// ---------------------------------------------------------------------------

describe('ConstraintManager.registerSetupSequence', () => {
  it('subsequent registers overwrite earlier ones for the same pair', () => {
    const m = newManager();
    m.registerSetupSequence('A', 'B', 30);
    m.registerSetupSequence('A', 'B', 60);
    const op = makeOp('OP1', 0, 0);
    expect(m.calculateOperationDuration(op, 'A', 'B')).toBe(60);
  });
});

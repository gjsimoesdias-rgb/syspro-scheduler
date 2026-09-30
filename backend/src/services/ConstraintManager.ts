/**
 * ConstraintManager - Manages scheduling constraints and rules
 * Handles: overtime, batching, queue times, movement times, setup times, material availability
 */

import { Operation, Resource, Workcentre } from '../types';
import environment from '../config/environment';

export interface TimeWindowConstraint {
  startTime: Date;
  endTime: Date;
  allowOvertime: boolean;
  maxOvertimeHours: number;
}

export interface BatchConstraint {
  minimumBatchSize: number;
  maximumBatchSize?: number;
  setupTimeMinutes: number;
  itemCode: string;
}

export interface MovementConstraint {
  fromWorkcentreId: string;
  toWorkcentreId: string;
  movementTimeMinutes: number;
}

export interface SequenceDependency {
  predecessorOpId: string;
  successorOpId: string;
  minTimeBetween?: number; // minutes for queue time
}

export class ConstraintManager {
  private overtimeRules: Map<string, number> = new Map(); // worcentreId -> maxOvertimePerDay
  private batchRules: Map<string, BatchConstraint> = new Map(); // itemCode -> BatchConstraint
  private movementMatrix: Map<string, number> = new Map(); // "A->B" -> minutes
  private sequenceDependencies: SequenceDependency[] = [];
  private setupSequenceMatrix: Map<string, number> = new Map(); // "itemA->itemB" -> minutes

  /**
   * Initialize constraints from context
   */
  initializeConstraints(
    workcentres: Map<string, Workcentre>,
    operations?: Operation[]
  ): void {
    // Load overtime constraints for each workcentre
    workcentres.forEach((wc) => {
      this.overtimeRules.set(
        wc.worcentreId,
        wc.maxOvertimePerDay || environment.maxOvertimePerDay
      );
    });

    // Initialize movement matrix
    this.initializeMovementMatrix();

    // Load sequence-dependent setups
    if (operations) {
      this.loadSetupSequences(operations);
    }
  }

  /**
   * Check if operation can be scheduled in given time window
   */
  canScheduleInWindow(
    operation: Operation,
    windowStart: Date,
    windowEnd: Date,
    worcentre: Workcentre,
    resource: Resource,
    existingSchedules: any[] = []
  ): boolean {
    const totalDuration =
      operation.setupTime + operation.duration;
    const requiredSeconds = totalDuration * 60;
    const availableSeconds = windowEnd.getTime() - windowStart.getTime();

    // Basic time check
    if (availableSeconds < requiredSeconds) {
      return false;
    }

    // Check resource availability
    if (!this.isResourceAvailable(resource, windowStart, windowEnd, existingSchedules)) {
      return false;
    }

    // Check workcentre availability
    if (!this.isWorkcentreAvailable(worcentre, windowStart, windowEnd, existingSchedules)) {
      return false;
    }

    // Check calendar constraints
    if (!this.isWithinWorkingHours(windowStart, windowEnd, worcentre)) {
      return false;
    }

    return true;
  }

  /**
   * Calculate total operation time including setup, process, queue, and movement
   */
  calculateOperationDuration(
    operation: Operation,
    previousItemCode?: string,
    currentItemCode?: string
  ): number {
    let totalMinutes = 0;

    // Setup time (may be dependent on sequence)
    if (previousItemCode && currentItemCode) {
      const sequenceSetup = this.getSequenceSetupTime(
        previousItemCode,
        currentItemCode,
        operation.workcentreId
      );
      totalMinutes += sequenceSetup ?? operation.setupTime;
    } else {
      totalMinutes += operation.setupTime;
    }

    // Process/run time
    totalMinutes += operation.duration;

    // Queue time
    totalMinutes += operation.queueTime;

    // Movement time (will be added at transition)
    // totalMinutes += operation.moveTime;

    return totalMinutes;
  }

  /**
   * Apply batching constraints
   */
  canBatchOperations(
    operation: Operation,
    quantity: number,
    itemCode: string
  ): { canBatch: boolean; batchSize: number; reason?: string } {
    const batchRule = this.batchRules.get(itemCode);

    if (!batchRule) {
      // No specific rule; use operation batch size
      if (quantity >= operation.batchSize) {
        return { canBatch: true, batchSize: quantity };
      }
      return {
        canBatch: false,
        batchSize: 0,
        reason: `Quantity ${quantity} below minimum batch size ${operation.batchSize}`
      };
    }

    if (quantity < batchRule.minimumBatchSize) {
      return {
        canBatch: false,
        batchSize: 0,
        reason: `Quantity ${quantity} below minimum batch size ${batchRule.minimumBatchSize}`
      };
    }

    if (batchRule.maximumBatchSize && quantity > batchRule.maximumBatchSize) {
      return {
        canBatch: false,
        batchSize: 0,
        reason: `Quantity ${quantity} exceeds maximum batch size ${batchRule.maximumBatchSize}`
      };
    }

    return { canBatch: true, batchSize: quantity };
  }

  /**
   * Check overtime constraints
   */
  checkOvertimeConstraint(
    worcentreId: string,
    overtimeHoursSoFar: number,
    additionalHours: number
  ): {
    allowed: boolean;
    remainingOvertimeHours: number;
  } {
    const maxOvertime = this.overtimeRules.get(worcentreId) || environment.maxOvertimePerDay;
    const totalOvertime = overtimeHoursSoFar + additionalHours;

    return {
      allowed: totalOvertime <= maxOvertime,
      remainingOvertimeHours: Math.max(0, maxOvertime - overtimeHoursSoFar)
    };
  }

  /**
   * Calculate movement time between workcentres
   */
  getMovementTime(fromWorcentreId: string, toWorcentreId: string): number {
    if (fromWorcentreId === toWorcentreId) {
      return 0;
    }

    const key = `${fromWorcentreId}->${toWorcentreId}`;
    return this.movementMatrix.get(key) || environment.defaultMovementTimeMinutes;
  }

  /**
   * Check if resource is available in time window
   */
  private isResourceAvailable(
    resource: Resource,
    startTime: Date,
    endTime: Date,
    existingSchedules: any[]
  ): boolean {
    // Check status
    if (resource.status !== 'Available') {
      return false;
    }

    // Check existing schedules for conflicts
    for (const schedule of existingSchedules) {
      if (schedule.resourceId === resource.resourceId) {
        const schedStart = new Date(schedule.plannedStartDate);
        const schedEnd = new Date(schedule.plannedEndDate);

        // Check for overlap
        if (startTime < schedEnd && endTime > schedStart) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Check if workcentre is available in time window
   */
  private isWorkcentreAvailable(
    workcentre: Workcentre,
    startTime: Date,
    endTime: Date,
    existingSchedules: any[]
  ): boolean {
    // Check existing schedules for conflicts
    for (const schedule of existingSchedules) {
      if (schedule.workcentreId === workcentre.worcentreId) {
        const schedStart = new Date(schedule.plannedStartDate);
        const schedEnd = new Date(schedule.plannedEndDate);

        // Check for overlap (some workcentres may handle parallel operations)
        if (startTime < schedEnd && endTime > schedStart) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Check if time window is within working hours.
   * Uses the workcentre's calendar if provided; falls back to a
   * configurable default band rather than a hardcoded 6am–10pm window.
   */
  private isWithinWorkingHours(startTime: Date, endTime: Date, workcentre: Workcentre): boolean {
    const calendar: any = (workcentre as any).calendar;

    if (calendar?.shifts?.length) {
      // Use the actual shift definitions from the workcentre calendar
      const startH = startTime.getHours() * 60 + startTime.getMinutes();
      const endH   = endTime.getHours()   * 60 + endTime.getMinutes();

      for (const shift of calendar.shifts) {
        const shiftStart = this.parseShiftTime(shift.startTime);
        const shiftEnd   = this.parseShiftTime(shift.endTime);
        if (startH >= shiftStart && endH <= shiftEnd) {
          return true;
        }
      }
      return false;
    }

    // No calendar: default to a standard 08:00–16:00 band
    const defaultStart = 8;
    const defaultEnd   = 16;
    const startHour    = startTime.getHours() + startTime.getMinutes() / 60;
    const endHour      = endTime.getHours()   + endTime.getMinutes()   / 60;
    return startHour >= defaultStart && endHour <= defaultEnd;
  }

  private parseShiftTime(time?: string): number {
    if (!time) return 0;
    const [h, m] = time.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  /**
   * Register a batch constraint
   */
  registerBatchConstraint(itemCode: string, constraint: BatchConstraint): void {
    this.batchRules.set(itemCode, constraint);
  }

  /**
   * Register movement time between workcentres
   */
  registerMovementTime(fromId: string, toId: string, minutes: number): void {
    this.movementMatrix.set(`${fromId}->${toId}`, minutes);
  }

  /**
   * Register setup sequence dependency
   */
  registerSetupSequence(fromItem: string, toItem: string, setupMinutes: number): void {
    this.setupSequenceMatrix.set(`${fromItem}->${toItem}`, setupMinutes);
  }

  /**
   * Get all overtime rules
   */
  getOvertimeRules(): Map<string, number> {
    return this.overtimeRules;
  }

  /**
   * Initialize default movement matrix
   */
  private initializeMovementMatrix(): void {
    // Can be expanded with real movement times from Syspro
    this.movementMatrix.clear();
  }

  /**
   * Load setup sequences from operations
   * Derives sequence-dependent setup times by grouping operations on the
   * same workcentre by the item they produce, then using each operation's
   * setupTime as the changeover cost for that (from → to) pair.
   *
   * This is a heuristic: if job A runs item "WIDGET-A" and job B runs
   * "WIDGET-B" on the same workcentre, and B has a setupTime of 45 min,
   * we record "WIDGET-A->WIDGET-B = 45" in the matrix.  The actual
   * sequence-specific matrix is loaded via loadExternalSequences() when
   * a sch_SetupMatrix table is available.
   */
  private loadSetupSequences(operations: Operation[]): void {
    // Group operations by workcentreId to find item-to-item changeovers
    const byWC = new Map<string, Array<{ itemCode: string; setupTime: number }>>();

    for (const op of operations) {
      const wc = op.workcentreId;
      if (!byWC.has(wc)) byWC.set(wc, []);
      // itemCode may live on the parent job; it's injected as (op as any).itemCode
      const itemCode: string = (op as any).itemCode || op.workcentreId;
      byWC.get(wc)!.push({ itemCode, setupTime: op.setupTime || 0 });
    }

    // For every distinct item pair on the same workcentre, record the higher
    // of the two operation setup times as the changeover cost.
    byWC.forEach((ops) => {
      for (let i = 0; i < ops.length; i++) {
        for (let j = 0; j < ops.length; j++) {
          // Same item is not a changeover (setup-once-per-group decides that).
          if (i === j || ops[i].itemCode === ops[j].itemCode) continue;
          const key = `${ops[i].itemCode}->${ops[j].itemCode}`;
          if (!this.setupSequenceMatrix.has(key)) {
            this.setupSequenceMatrix.set(key, ops[j].setupTime);
          }
        }
      }
    });
  }

  /**
   * Load externally-supplied sequence matrix rows (e.g. from sch_SetupMatrix).
   * These override heuristic values derived from loadSetupSequences().
   *
   * Rows carrying a workcentreId are stored under a workcentre-specific key
   * (`wc|from->to`) that takes precedence over the generic `from->to` entry,
   * so the same item transition can cost 20 min on one machine group and
   * 90 min on another — matching how Opcenter/Asprova model changeovers.
   */
  loadExternalSequences(
    sequences: Array<{ fromItemCode: string; toItemCode: string; setupTimeMinutes: number; workcentreId?: string }>
  ): void {
    for (const row of sequences) {
      const key = `${row.fromItemCode}->${row.toItemCode}`;
      if (row.workcentreId) {
        this.setupSequenceMatrix.set(`${row.workcentreId}|${key}`, row.setupTimeMinutes);
        // Also seed the generic entry if no other row claimed it, so lookups
        // without a workcentre still benefit from the matrix.
        if (!this.setupSequenceMatrix.has(key)) {
          this.setupSequenceMatrix.set(key, row.setupTimeMinutes);
        }
      } else {
        this.setupSequenceMatrix.set(key, row.setupTimeMinutes);
      }
    }
  }

  /**
   * Resolve the sequence-dependent setup time for an item transition.
   * Workcentre-specific entries win over generic ones. Returns undefined
   * when the matrix has no entry for this transition.
   */
  getSequenceSetupTime(
    previousItemCode: string,
    currentItemCode: string,
    workcentreId?: string
  ): number | undefined {
    const key = `${previousItemCode}->${currentItemCode}`;
    if (workcentreId) {
      const specific = this.setupSequenceMatrix.get(`${workcentreId}|${key}`);
      if (specific !== undefined) return specific;
    }
    return this.setupSequenceMatrix.get(key);
  }
}

export default ConstraintManager;

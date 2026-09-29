/**
 * Shared types and interfaces used across frontend and backend
 */

// ==================== PRODUCTION MODE ====================

/** Controls whether operations of a job must stay on the same production line. */
export type ProductionMode = 'job-shop' | 'flow-line' | 'mixed';

// ==================== CORE ENTITIES ====================

export interface Job {
  jobId: string;
  itemCode: string;
  description: string;
  quantity: number;
  dueDate: Date;
  releaseDate: Date;
  priority: number; // 1=highest, 10=lowest
  status: 'Released' | 'Firm' | 'Planned' | 'InProgress' | 'Complete' | 'OnHold';
  operations: Operation[];
  estimatedMaterialCost: number;
  estimatedLaborCost: number;
  /** Overrides system productionMode when the overall mode is 'mixed'. */
  productionMode?: ProductionMode;
  /**
   * SYSPRO master/sub-job hierarchy (WipMasterSub). A sub-job feeds its
   * master job, so every sub-job must finish before the master may start.
   */
  masterJobId?: string | null;
  isMasterJob?: boolean;
  isSubJob?: boolean;
  [key: string]: unknown;
}

export interface Operation {
  opId: string;
  jobId: string;
  sequence: number;
  workcentreId: string;
  workcentreName: string;
  duration: number; // minutes
  setupTime: number; // minutes
  queueTime: number; // minutes
  moveTime: number; // minutes
  batchSize: number; // min run quantity
  qualifiedResourceIds: string[];
  status: 'NotStarted' | 'InProgress' | 'Complete';
  plannedStartDate?: Date;
  plannedEndDate?: Date;
  actualStartDate?: Date;
  actualEndDate?: Date;
  assignedResourceId?: string;
  predecessorOpId?: string;
  successorOpId?: string;
  /** Subcontract (outside) operation: takes elapsed calendar time, books no machine. */
  isSubcontract?: boolean;
  subcontractSupplier?: string;
  /** Elapsed time for a subcontract op, in minutes (converted from SYSPRO ElapsedTime). */
  elapsedMinutes?: number;
  [key: string]: unknown;
}

export interface Workcentre {
  worcentreId: string;
  name: string;
  description: string;
  capabilities: string[]; // machine type, tools available
  shiftProfile: ShiftProfile;
  calendar: Calendar;
  costPerHour: number;
  maxOvertimePerDay: number; // hours
  setupSequenceDependencies?: SetupSequence[];
}

export interface Resource {
  resourceId: string;
  name: string;
  type: 'Employee' | 'Machine';
  worcentreId: string;
  skillTags: string[];
  costPerHour: number;
  calendar: Calendar;
  status: 'Available' | 'OnLeave' | 'Unavailable';
  /** Optional flow-line group identifier. Resources sharing the same lineGroupId
   * belong to the same physical production line. */
  lineGroupId?: string;
}

export interface Material {
  materialId: string;
  code: string;
  description: string;
  unitOfMeasure: string;
  stockQty: number;
  reservedQty: number;
  leadTimeDays: number;
  minimumOrderQty: number;
}

export interface BOMLine {
  bomId: string;
  itemCode: string;
  componentCode: string;
  quantityRequired: number;
  unitOfMeasure: string;
  scrapFactor: number;
}

export interface SetupSequence {
  fromItemCode: string;
  toItemCode: string;
  setupTimeMinutes: number;
  /** Optional workcentre scope — workcentre-specific entries override generic ones. */
  workcentreId?: string;
}

// ==================== SCHEDULING ====================

export interface Schedule {
  scheduleId: string;
  scheduledDate: Date;
  version: number;
  status: 'Draft' | 'Approved' | 'Exported' | 'Released' | 'Executing' | 'Complete';
  planningHorizon: {
    startDate: Date;
    endDate: Date;
  };
  jobSchedules: JobSchedule[];
  resourceLoads: ResourceLoad[];
  constraintViolations: ConstraintViolation[];
  metrics: ScheduleMetrics;
}

export interface JobSchedule {
  jobId: string;
  plannedStartDate: Date;
  plannedEndDate: Date;
  operationSchedules: OperationSchedule[];
  estimatedTardiness: number; // days late
  status: 'Scheduled' | 'ConstraintViolation' | 'Unschedulable';
}

export interface OperationSchedule {
  opId: string;
  workcentreId: string;
  resourceId: string;
  plannedStartDate: Date;
  plannedEndDate: Date;
  duration: number; // minutes (machine-booked time: setup+run)
  // Time-phase breakdown (minutes)
  setupTime: number;
  runTime: number;
  queueTime: number;
  moveTime: number;
  // Phase timestamps
  setupStart: Date;
  setupEnd: Date;
  runStart: Date;
  runEnd: Date;
  queueEnd: Date;
  moveEnd: Date;
  // Metadata
  sequence: number; // operation sequence number within job
  isOvertimeSlot: boolean;
  batchSize: number;
  slackTime: number; // minutes
  /** Operation status from SYSPRO WipJobAllLab.OperationStatus */
  opStatus?: 'NotStarted' | 'InProgress' | 'Complete';
  /** True when this operation was pinned by the user and its time slot was frozen. */
  pinned?: boolean;
}

/**
 * A pinned operation record — the scheduler pre-places this slot and will
 * not move it during auto-scheduling.  Stored in sch_AppState under the
 * 'pinnedOperations' key.
 */
export interface PinnedOperation {
  jobId: string;
  opId: string;
  workcentreId: string;
  resourceId: string;
  plannedStartDate: string; // ISO 8601
  plannedEndDate: string;   // ISO 8601
  pinnedAt: string;         // ISO 8601
  pinnedBy?: string;
}

export interface ResourceLoad {
  resourceId: string;
  date: Date;
  regularHours: number;
  overtimeHours: number;
  utilizationRate: number; // %
  assignedOperations: OperationSchedule[];
}

export interface ConstraintViolation {
  violationId: string;
  type:
    | 'MaterialShortage'
    | 'OvertimeExceeded'
    | 'CapacityExceeded'
    | 'ScheduleDateViolation'
    | 'SetupConflict'
    | 'SkillMismatch'
    | 'LineGroupViolation'
    | 'BatchViolation'
    | 'MasterJobPrecedence';
  severity: 'Critical' | 'Warning' | 'Info';
  affectedJobId?: string;
  affectedOperationId?: string;
  affectedResourceId?: string;
  description: string;
  suggestedAction?: string;
}

export interface ScheduleMetrics {
  totalJobsScheduled: number;
  jobsOnTime: number;
  jobsTardy: number;
  averageTardiness: number; // days
  resourceUtilization: number; // %
  overtimeHours: number;
  criticalPathLength: number; // hours
  totalSetupTime: number; // hours
  totalQueueTime: number; // hours
  totalMoveTime: number; // hours
  // ── Time model (same definitions as LYNQ Gen 3). All hours over the planning
  //    horizon, summed across workcentres; % are of operating time. ──
  /** Shift / working time available. */
  operatingHours?: number;
  /** Setup + run booked on the line. */
  busyHours?: number;
  /** Run time only (excl. setup/changeover). */
  productiveHours?: number;
  /** Setup / changeover time. */
  directDowntimeHours?: number;
  /** Operating time with nothing booked. */
  idleHours?: number;
  busyPct?: number;
  productivePct?: number;
  directDowntimePct?: number;
  idlePct?: number;
  /** On-time delivery: scheduled jobs finishing by their due date, % */
  otdRate?: number;
  /** Average planned start → finish, days. */
  avgLeadTimeDays?: number;
  /** Jobs that could not be fully scheduled. */
  jobsUnscheduled?: number;
}

// ==================== CALENDAR & AVAILABILITY ====================

export interface Calendar {
  calendarId: string;
  name: string;
  workingDays: number[]; // 0-6 (Sunday-Saturday)
  workingHoursPerDay: number;
  shifts: Shift[];
  holidays: Holiday[];
}

export interface Shift {
  shiftId: string;
  name: string;
  startTime: string; // HH:MM format
  endTime: string; // HH:MM format
  breakTime: number; // minutes
  diversions?: Array<{
    id: string;
    type: string;
    startTime: string;
    endTime: string;
    schedulable: boolean;
  }>;
}

export interface Holiday {
  holidayId: string;
  date: Date;
  name: string;
  isWorking: boolean;
}

export interface ShiftProfile {
  name: string;
  shifts: Shift[];
  weeksPerCycle: number;
}

// ==================== API REQUESTS/RESPONSES ====================

export interface ScheduleRequest {
  planningHorizonStartDate: Date;
  planningHorizonEndDate: Date;
  jobFilter?: {
    statuses?: string[];
    priorities?: number[];
    dueDateBefore?: Date;
  };
  schedulingRule?: 'priority' | 'edd' | 'fifo' | 'spt' | 'critical-ratio';
  schedulingDirection?: 'forward' | 'backward';
  dateAnchorMode?: 'manual' | 'syspro';
  anchorDate?: Date | string;
  selectedJobIds?: string[];
  /** Which scheduling algorithm to use. Defaults to 'greedy'. */
  engineType?: 'greedy' | 'cp-sat';
  /**
   * Multi-objective weights for the CP-SAT solver (0–100 each).
   * Only used when engineType = 'cp-sat'. Values need not sum to 100.
   */
  cpSatWeights?: {
    tardiness: number;
    makespan: number;
    changeover: number;
  };
  /** CP-SAT solver wall-clock time limit (seconds, default 30, max 300). */
  cpSatTimeLimitSeconds?: number;
  /** Production mode for this schedule run. Defaults to 'job-shop'. */
  productionMode?: ProductionMode;
  /** Per-job line group overrides (jobId → lineGroupId). Only used in mixed mode. */
  lineGroupOverrides?: Record<string, string>;
  /**
   * Frozen zone (firm time fence) in days. Operations from the latest saved
   * schedule that start within this many days from now keep their exact slots
   * (auto-pinned) so short-term schedule nervousness is eliminated. 0 = off.
   */
  freezeHorizonDays?: number;
}

export interface ScheduleResponse {
  schedule: Schedule;
  executionTimeMs: number;
  warningCount: number;
  errorCount: number;
}


export interface JobUpdateRequest {
  jobId: string;
  plannedStartDate: Date;
  plannedEndDate: Date;
}

export interface ResourceAllocationRequest {
  operationId: string;
  resourceId: string;
  startDate: Date;
  endDate: Date;
}

export interface MaterialReservationRequest {
  materialId: string;
  jobId: string;
  quantity: number;
}

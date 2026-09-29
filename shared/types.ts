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
  status: 'Draft' | 'Approved' | 'Released' | 'Executing' | 'Complete';
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
  duration: number; // minutes (total: setup+run+queue+move)
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
    | 'BatchViolation';
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

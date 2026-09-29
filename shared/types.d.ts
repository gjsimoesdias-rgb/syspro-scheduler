/**
 * Shared types and interfaces used across frontend and backend
 */
export interface Job {
    jobId: string;
    itemCode: string;
    description: string;
    quantity: number;
    dueDate: Date;
    releaseDate: Date;
    priority: number;
    status: 'Released' | 'Firm' | 'Planned' | 'InProgress' | 'Complete' | 'OnHold';
    operations: Operation[];
    estimatedMaterialCost: number;
    estimatedLaborCost: number;
}
export interface Operation {
    opId: string;
    jobId: string;
    sequence: number;
    workcentreId: string;
    workcentreName: string;
    duration: number;
    setupTime: number;
    queueTime: number;
    moveTime: number;
    batchSize: number;
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
    capabilities: string[];
    shiftProfile: ShiftProfile;
    calendar: Calendar;
    costPerHour: number;
    maxOvertimePerDay: number;
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
}
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
    estimatedTardiness: number;
    status: 'Scheduled' | 'ConstraintViolation' | 'Unschedulable';
}
export interface OperationSchedule {
    opId: string;
    workcentreId: string;
    resourceId: string;
    plannedStartDate: Date;
    plannedEndDate: Date;
    duration: number;
    isOvertimeSlot: boolean;
    batchSize: number;
    slackTime: number;
}
export interface ResourceLoad {
    resourceId: string;
    date: Date;
    regularHours: number;
    overtimeHours: number;
    utilizationRate: number;
    assignedOperations: OperationSchedule[];
}
export interface ConstraintViolation {
    violationId: string;
    type: 'MaterialShortage' | 'CapacityExceeded' | 'ScheduleDateViolation' | 'SetupConflict' | 'SkillMismatch';
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
    averageTardiness: number;
    resourceUtilization: number;
    overtimeHours: number;
    criticalPathLength: number;
    totalSetupTime: number;
    totalQueueTime: number;
    totalMoveTime: number;
}
export interface Calendar {
    calendarId: string;
    name: string;
    workingDays: number[];
    workingHoursPerDay: number;
    shifts: Shift[];
    holidays: Holiday[];
}
export interface Shift {
    shiftId: string;
    name: string;
    startTime: string;
    endTime: string;
    breakTime: number;
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
//# sourceMappingURL=types.d.ts.map
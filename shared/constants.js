"use strict";
/**
 * Scheduler constants
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SCHEDULER_CONSTANTS = void 0;
exports.SCHEDULER_CONSTANTS = {
    // Default time values (minutes)
    DEFAULT_SETUP_TIME: 30,
    DEFAULT_QUEUE_TIME: 15,
    DEFAULT_MOVEMENT_TIME: 10,
    // Workday boundaries
    WORKDAY_START_HOUR: 6,
    WORKDAY_END_HOUR: 22,
    HOURS_PER_STANDARD_DAY: 8,
    // Job priorities
    PRIORITY_CRITICAL: 1,
    PRIORITY_HIGH: 3,
    PRIORITY_NORMAL: 5,
    PRIORITY_LOW: 8,
    // Schedule statuses
    SCHEDULE_STATUS: {
        DRAFT: 'Draft',
        APPROVED: 'Approved',
        RELEASED: 'Released',
        EXECUTING: 'Executing',
        COMPLETE: 'Complete'
    },
    // Job statuses
    JOB_STATUS: {
        RELEASED: 'Released',
        FIRM: 'Firm',
        PLANNED: 'Planned',
        IN_PROGRESS: 'InProgress',
        COMPLETE: 'Complete',
        ON_HOLD: 'OnHold'
    },
    // Operation statuses
    OPERATION_STATUS: {
        NOT_STARTED: 'NotStarted',
        IN_PROGRESS: 'InProgress',
        COMPLETE: 'Complete'
    },
    // Constraint types
    CONSTRAINT_TYPES: {
        MATERIAL_SHORTAGE: 'MaterialShortage',
        CAPACITY_EXCEEDED: 'CapacityExceeded',
        SCHEDULE_DATE_VIOLATION: 'ScheduleDateViolation',
        SETUP_CONFLICT: 'SetupConflict',
        SKILL_MISMATCH: 'SkillMismatch'
    },
    // Severity levels
    SEVERITY: {
        CRITICAL: 'Critical',
        WARNING: 'Warning',
        INFO: 'Info'
    },
    // Resource types
    RESOURCE_TYPE: {
        EMPLOYEE: 'Employee',
        MACHINE: 'Machine'
    },
    // Default calendar
    DEFAULT_WORKING_DAYS: [1, 2, 3, 4, 5], // Mon-Fri
    DEFAULT_WORKING_HOURS_PER_DAY: 8
};
exports.default = exports.SCHEDULER_CONSTANTS;
//# sourceMappingURL=constants.js.map
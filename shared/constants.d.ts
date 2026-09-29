/**
 * Scheduler constants
 */
export declare const SCHEDULER_CONSTANTS: {
    DEFAULT_SETUP_TIME: number;
    DEFAULT_QUEUE_TIME: number;
    DEFAULT_MOVEMENT_TIME: number;
    WORKDAY_START_HOUR: number;
    WORKDAY_END_HOUR: number;
    HOURS_PER_STANDARD_DAY: number;
    PRIORITY_CRITICAL: number;
    PRIORITY_HIGH: number;
    PRIORITY_NORMAL: number;
    PRIORITY_LOW: number;
    SCHEDULE_STATUS: {
        DRAFT: string;
        APPROVED: string;
        RELEASED: string;
        EXECUTING: string;
        COMPLETE: string;
    };
    JOB_STATUS: {
        RELEASED: string;
        FIRM: string;
        PLANNED: string;
        IN_PROGRESS: string;
        COMPLETE: string;
        ON_HOLD: string;
    };
    OPERATION_STATUS: {
        NOT_STARTED: string;
        IN_PROGRESS: string;
        COMPLETE: string;
    };
    CONSTRAINT_TYPES: {
        MATERIAL_SHORTAGE: string;
        CAPACITY_EXCEEDED: string;
        SCHEDULE_DATE_VIOLATION: string;
        SETUP_CONFLICT: string;
        SKILL_MISMATCH: string;
    };
    SEVERITY: {
        CRITICAL: string;
        WARNING: string;
        INFO: string;
    };
    RESOURCE_TYPE: {
        EMPLOYEE: string;
        MACHINE: string;
    };
    DEFAULT_WORKING_DAYS: number[];
    DEFAULT_WORKING_HOURS_PER_DAY: number;
};
export default SCHEDULER_CONSTANTS;
//# sourceMappingURL=constants.d.ts.map
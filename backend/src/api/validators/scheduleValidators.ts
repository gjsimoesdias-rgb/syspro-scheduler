/**
 * Zod schemas for schedule API request bodies.
 * Applied at route entry; returns HTTP 400 with field paths on validation failure.
 */

import { z } from 'zod';

// ─── Reusable atoms ───────────────────────────────────────────────────────────

const isoDateString = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Must be a valid ISO date string' });

/** Must match ScheduleSetupModal's rule options and SchedulingEngine.prioritizeJobs. */
const schedulingRuleSchema = z
  .enum(['priority', 'edd', 'fifo', 'spt', 'critical-ratio'])
  .optional();

const schedulingDirectionSchema = z.enum(['forward', 'backward']).optional();

const dateAnchorModeSchema = z.enum(['syspro', 'manual']).optional();

// ─── POST /api/schedule/generate ─────────────────────────────────────────────

export const generateScheduleSchema = z.object({
  schedulingRule: schedulingRuleSchema,
  schedulingDirection: schedulingDirectionSchema,
  dateAnchorMode: dateAnchorModeSchema,
  anchorDate: isoDateString.optional(),
  // Field names must match what useScheduleGeneration.ts actually posts.
  planningHorizonStartDate: isoDateString.optional(),
  planningHorizonEndDate: isoDateString.optional(),
  selectedJobIds: z.array(z.string()).optional(),
  excludedJobIds: z.array(z.string()).optional(),
  pinnedJobIds: z.array(z.string()).optional(),
  useAlternatives: z.boolean().optional(),
  /** Which scheduling algorithm to run. Defaults to 'greedy'. */
  engineType: z.enum(['greedy', 'cp-sat']).optional().default('greedy'),
  /** Multi-objective weights for CP-SAT (0–100 each; need not sum to 100). */
  cpSatWeights: z
    .object({
      tardiness: z.number().min(0).max(100),
      makespan: z.number().min(0).max(100),
      changeover: z.number().min(0).max(100),
    })
    .optional(),
  /** CP-SAT wall-clock limit in seconds (default 30, max 300). */
  cpSatTimeLimitSeconds: z.number().min(1).max(300).optional(),
  /** System-wide production mode. Defaults to 'job-shop'. */
  productionMode: z.enum(['job-shop', 'flow-line', 'mixed']).optional().default('job-shop'),
  /** Per-job overrides when productionMode is 'mixed'. Key = jobId, value = lineGroupId. */
  lineGroupOverrides: z.record(z.string(), z.string()).optional(),
  /** Frozen zone (firm time fence) in days. 0/omitted = off. */
  freezeHorizonDays: z.number().min(0).max(365).optional(),
});

export type GenerateScheduleBody = z.infer<typeof generateScheduleSchema>;

// ─── POST /api/schedule/optimize (sequencing rule comparison) ────────────────

export const optimizeScheduleSchema = z.object({
  /** Candidate dispatching rules to run and compare. Defaults to all five. */
  rules: z
    .array(z.enum(['priority', 'edd', 'fifo', 'spt', 'critical-ratio']))
    .min(1)
    .max(5)
    .optional(),
  /** How to rank the outcomes. Defaults to 'balanced'. */
  objective: z.enum(['balanced', 'on-time', 'tardiness', 'makespan', 'setup']).optional(),
  // The remaining fields mirror /generate so the comparison uses identical inputs.
  schedulingDirection: schedulingDirectionSchema,
  dateAnchorMode: dateAnchorModeSchema,
  anchorDate: isoDateString.optional(),
  planningHorizonStartDate: isoDateString.optional(),
  planningHorizonEndDate: isoDateString.optional(),
  selectedJobIds: z.array(z.string()).optional(),
  productionMode: z.enum(['job-shop', 'flow-line', 'mixed']).optional().default('job-shop'),
  lineGroupOverrides: z.record(z.string(), z.string()).optional(),
});

export type OptimizeScheduleBody = z.infer<typeof optimizeScheduleSchema>;

// ─── POST /api/schedule/save ──────────────────────────────────────────────────

const scheduleIdSchema = z.string().min(1, 'scheduleId must not be empty');

export const saveScheduleSchema = z.object({
  schedule: z
    .object({
      scheduleId: scheduleIdSchema,
    })
    .passthrough(), // allow all other schedule fields through
});

export type SaveScheduleBody = z.infer<typeof saveScheduleSchema>;

// ─── POST /api/schedule/:scheduleId/approve-override ─────────────────────────

export const approveOverrideSchema = z.object({
  violationId: z.string().min(1, 'violationId is required'),
  reason: z.string().min(1, 'reason is required').max(1000, 'reason must be ≤ 1000 characters'),
});

export type ApproveOverrideBody = z.infer<typeof approveOverrideSchema>;

// ─── Setup matrix (sequence-dependent changeovers) ───────────────────────────

export const setupMatrixRowSchema = z.object({
  // '*' is the sentinel for a GLOBAL (all-workcentre) changeover row. Defaults
  // to global so the grid matrix can post cells without a workcentre.
  workcentreId: z.string().min(1).max(50).default('*'),
  fromItemCode: z.string().min(1, 'fromItemCode is required').max(50),
  toItemCode: z.string().min(1, 'toItemCode is required').max(50),
  setupMinutes: z.number().int().min(0).max(100000),
});

export type SetupMatrixRowBody = z.infer<typeof setupMatrixRowSchema>;

// Bulk upsert for the Changeover Matrix grid. setupMinutes = 0 deletes the cell.
export const setupMatrixBulkSchema = z.object({
  rows: z.array(setupMatrixRowSchema).max(20000),
});

export type SetupMatrixBulkBody = z.infer<typeof setupMatrixBulkSchema>;

// ProductClass-level changeover matrix (Changeover Matrix grid).
export const setupClassRowSchema = z.object({
  fromClass: z.string().min(1).max(50),
  toClass: z.string().min(1).max(50),
  setupMinutes: z.number().int().min(0).max(100000),
});
export const setupClassBulkSchema = z.object({
  rows: z.array(setupClassRowSchema).max(20000),
});
export type SetupClassBulkBody = z.infer<typeof setupClassBulkSchema>;

// ─── POST /api/schedule/ctp (capable-to-promise) ─────────────────────────────

const ctpOperationSchema = z.object({
  workcentreId: z.string().min(1),
  setupMinutes: z.number().min(0).max(100000).default(0),
  runMinutes: z.number().min(1).max(1000000),
  description: z.string().max(200).optional(),
});

export const ctpRequestSchema = z.object({
  operations: z
    .array(ctpOperationSchema)
    .min(1, 'At least one operation is required')
    .max(50),
  /**
   * SYSPRO master/sub families: sub-job routings simulated in parallel
   * before the master routing (operations above) is allowed to start.
   */
  subJobs: z
    .array(
      z.object({
        label: z.string().max(100).optional(),
        operations: z.array(ctpOperationSchema).min(1).max(50),
      })
    )
    .max(20)
    .optional(),
  /** Optional customer-requested date; response reports whether it can be met. */
  desiredDueDate: isoDateString.optional(),
  /** Earliest allowed start (e.g. material arrival). Defaults to now. */
  earliestStart: isoDateString.optional(),
});

export type CtpRequestBody = z.infer<typeof ctpRequestSchema>;

// ─── Helper ──────────────────────────────────────────────────────────────────

/**
 * Validate `body` against `schema`. Returns `{ ok: true, data }` or
 * `{ ok: false, error }` where `error` is safe to send as a 400 response body.
 */
export function validate<T>(
  schema: z.ZodType<T>,
  body: unknown
): { ok: true; data: T } | { ok: false; error: { error: string; details: z.ZodIssue[] } } {
  const result = schema.safeParse(body);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return {
    ok: false,
    error: {
      error: 'Validation failed',
      details: result.error.issues,
    },
  };
}

/**
 * SYSPRO MRP suggested jobs (MrpSugJobMaster / MrpSugJobAlLab / MrpSugJobAlMat)
 * are planned work, not jobs yet. They join the plan under an `MRP-` id so they
 * never collide with WipMaster job numbers, and they are never published back.
 */
export const SUGGESTED_PREFIX = 'MRP-';

export const isSuggestedJobId = (jobId: unknown): boolean =>
  String(jobId ?? '').trim().toUpperCase().startsWith(SUGGESTED_PREFIX);

/** The SYSPRO suggested-job number behind an `MRP-` id. */
export const suggestedJobNumber = (jobId: unknown): string =>
  String(jobId ?? '').trim().slice(SUGGESTED_PREFIX.length);

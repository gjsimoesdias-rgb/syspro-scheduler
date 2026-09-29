/**
 * Job/operation filters applied before a scheduling run.
 */

import { Job } from '../types';

export interface StripCompletedResult {
  jobs: Job[];
  completedOpsExcluded: number;
  jobsExcluded: number;
}

/**
 * Company policy `jobManagement.includeCompletedOps = false` (the default):
 * completed operations must not be rescheduled, and jobs with nothing left
 * to do are dropped from the run entirely.
 */
export function stripCompletedOperations(jobs: Job[]): StripCompletedResult {
  const beforeJobs = jobs.length;
  const beforeOps = jobs.reduce((n, j) => n + (j.operations?.length || 0), 0);

  const filtered = jobs
    .map((j) => ({ ...j, operations: (j.operations || []).filter((op) => op.status !== 'Complete') }))
    .filter((j) => j.operations.length > 0);

  const afterOps = filtered.reduce((n, j) => n + j.operations.length, 0);

  return {
    jobs: filtered,
    completedOpsExcluded: beforeOps - afterOps,
    jobsExcluded: beforeJobs - filtered.length,
  };
}

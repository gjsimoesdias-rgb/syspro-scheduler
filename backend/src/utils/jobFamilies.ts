/**
 * Master/sub-job family completion (SYSPRO WipMasterSub).
 *
 * Scheduling one side of a master/sub pair without the other breaks the
 * "sub-jobs finish before the master starts" precedence rule, so a selection
 * is transitively expanded to cover whole families. Pure function — used by
 * POST /api/schedule/generate and unit-tested directly.
 */

import { Job } from '../types';

export interface FamilyCompletionResult {
  /** The expanded selection. */
  idSet: Set<string>;
  /** Job ids that were added to complete families (in discovery order). */
  familyAdded: string[];
}

export function completeJobFamilies(jobs: Job[], selectedJobIds: string[]): FamilyCompletionResult {
  const idSet = new Set(selectedJobIds);
  const familyAdded: string[] = [];

  let changed = true;
  while (changed) {
    changed = false;
    for (const j of jobs) {
      const masterId = (j.masterJobId as string | null) || null;
      if (!masterId || masterId === j.jobId) continue;

      if (idSet.has(j.jobId) && !idSet.has(masterId)) {
        idSet.add(masterId);
        familyAdded.push(masterId);
        changed = true;
      } else if (idSet.has(masterId) && !idSet.has(j.jobId)) {
        idSet.add(j.jobId);
        familyAdded.push(j.jobId);
        changed = true;
      }
    }
  }

  return { idSet, familyAdded };
}

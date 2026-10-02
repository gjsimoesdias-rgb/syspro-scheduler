/**
 * Job-level planning flags set from the jobs grid (right-click):
 *   excluded — left out of every scheduling run (Generate and Auto plan)
 *   pinned   — keeps the machine and times it has in the master plan
 *
 * Stored in sch_AppState ('jobFlags') so they survive reloads and apply to
 * the background Auto plan, not only to the browser that set them.
 */
import type { PinnedOperation } from '../types';
import { asObj } from './loose';

export interface JobFlags {
  excluded: string[];
  pinned: string[];
}

export const EMPTY_JOB_FLAGS: JobFlags = { excluded: [], pinned: [] };

const ids = (v: unknown): string[] =>
  Array.isArray(v)
    ? Array.from(new Set(v.map((x) => String(x ?? '').trim()).filter(Boolean))).slice(0, 20000)
    : [];

export function normaliseJobFlags(raw: unknown): JobFlags {
  const r = asObj(raw);
  return { excluded: ids(r.excluded), pinned: ids(r.pinned) };
}

/** Set or clear one flag on one job. Returns a new object. */
export function setJobFlag(flags: JobFlags, jobId: string, flag: keyof JobFlags, on: boolean): JobFlags {
  const id = String(jobId).trim();
  const next = new Set(flags[flag]);
  if (on) next.add(id); else next.delete(id);
  return { ...flags, [flag]: Array.from(next) };
}

/** Stored flags plus any sent with the request (older clients send them in the generate body). */
export function effectiveJobFlags(stored: unknown, body: { excludedJobIds?: unknown; pinnedJobIds?: unknown } = {}): {
  excluded: Set<string>; pinned: Set<string>;
} {
  const s = normaliseJobFlags(stored);
  return {
    excluded: new Set([...s.excluded, ...ids(body.excludedJobIds)]),
    pinned: new Set([...s.pinned, ...ids(body.pinnedJobIds)]),
  };
}

/**
 * Operation pins that hold every operation of the pinned jobs where the saved
 * master plan has it. Jobs not in the master (or ops without a machine) are
 * returned in `notInPlan` so the run can say why they still moved.
 */
export function pinsForJobs(
  master: { jobSchedules?: Array<{ jobId: string; operationSchedules?: Array<{
    opId: string; workcentreId: string; resourceId?: string; opStatus?: string;
    plannedStartDate: unknown; plannedEndDate: unknown;
  }> }> } | null | undefined,
  pinnedJobIds: Set<string>,
  pinnedBy = 'job-pin'
): { pins: Map<string, PinnedOperation>; notInPlan: string[] } {
  const pins = new Map<string, PinnedOperation>();
  const found = new Set<string>();
  const now = new Date().toISOString();
  for (const js of master?.jobSchedules || []) {
    const jobId = String(js?.jobId ?? '').trim();
    if (!pinnedJobIds.has(jobId)) continue;
    for (const os of js.operationSchedules || []) {
      const start = new Date(os.plannedStartDate as string);
      const end = new Date(os.plannedEndDate as string);
      if (!os.resourceId || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;
      if (os.opStatus === 'Complete') continue;
      found.add(jobId);
      pins.set(`${js.jobId}::${os.opId}`, {
        jobId: js.jobId,
        opId: os.opId,
        workcentreId: os.workcentreId,
        resourceId: os.resourceId,
        plannedStartDate: start.toISOString(),
        plannedEndDate: end.toISOString(),
        pinnedAt: now,
        pinnedBy,
      });
    }
  }
  return { pins, notInPlan: Array.from(pinnedJobIds).filter((id) => !found.has(id)) };
}

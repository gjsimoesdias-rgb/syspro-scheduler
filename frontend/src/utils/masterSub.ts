/**
 * Master/sub-job (SYSPRO WipMasterSub) helpers for the frontend.
 *
 * Single source of truth for:
 *  - extracting the master link from a job row (getMasterLinkValue)
 *  - resolving links to the exact jobIds of loaded jobs (buildParentMap)
 *  - walking a job up to its family root (getMasterRootJobId)
 *  - dependency checks for manual scheduling (clampMasterDropStart,
 *    describeDependencyViolation)
 *
 * The scheduling rule mirrors the backend engines: every sub-job must FINISH
 * before its master job may START.
 */
import type { Job, Schedule } from '../types';

const NON_LINK_TOKENS = new Set(['0', 'M', 'MASTER', 'N', 'NONE']);

/** Canonical comparison key: trim, numeric ids lose leading zeros. */
export const canonicalJobKey = (id: unknown): string => {
  const text = String(id ?? '').trim();
  if (!text) return '';
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : text.toUpperCase();
};

/**
 * Extract the raw master-job link from a job row, tolerating the various
 * SYSPRO/import field spellings. Numeric links are padded to the usual
 * 15-char SYSPRO key format (display fallback when no loaded job matches).
 */
export const getMasterLinkValue = (job: Job): string => {
  const source = job as Record<string, unknown>;
  const raw = source.masterJobId
    ?? source.MasterJobId
    ?? source.MasterJob
    ?? source.masterJob
    ?? source.WipMasterSub
    ?? source.wipMasterSub
    ?? source.ParentJob
    ?? source.parentJob
    ?? source.ParentJobId
    ?? source.parentJobId;
  // A duplicated column (wm.* plus an alias) comes back from mssql as an array;
  // take the first non-empty entry rather than blindly the first.
  const normalized = Array.isArray(raw) ? raw.find((v) => String(v ?? '').trim()) : raw;
  const text = String(normalized || '').trim();
  // SYSPRO job numbers can be alphanumeric — return the id as-is. (Stripping
  // non-digits and padding turned "MST-1" into "000000000000001", which then
  // never matched the master's jobId.) Values with no letters/digits (",",
  // "-") or all zeros are empty links, not a master called "," — the live
  // data has 34 such rows, which formed one phantom family.
  if (!/[A-Za-z0-9]/.test(text) || /^0+$/.test(text)) return '';
  return text;
};

/**
 * Build a sub → master map for the given jobs. Master ids are resolved to
 * the EXACT jobId string of a loaded job whenever possible (canonical
 * matching absorbs padding/trim differences); unresolved links keep the
 * legacy padded value so grouping-by-root still works.
 */
export const buildParentMap = (jobs: Job[]): Map<string, string> => {
  const byCanonical = new Map<string, string>();
  for (const job of jobs) {
    const key = canonicalJobKey(job.jobId);
    if (key && !byCanonical.has(key)) byCanonical.set(key, job.jobId);
  }

  const map = new Map<string, string>();
  for (const job of jobs) {
    const link = getMasterLinkValue(job);
    if (!link || NON_LINK_TOKENS.has(link.toUpperCase())) continue;

    const linkKey = canonicalJobKey(link);
    if (!linkKey || linkKey === canonicalJobKey(job.jobId)) continue;

    map.set(job.jobId, byCanonical.get(linkKey) ?? link);
  }
  return map;
};

/** Walk parent links up to the family root (cycle-safe). */
export const getMasterRootJobId = (jobId: string, parentMap: Map<string, string>): string => {
  let currentId = jobId;
  const seen = new Set<string>([currentId]);
  let parentId = parentMap.get(currentId);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    currentId = parentId;
    parentId = parentMap.get(currentId);
  }
  return currentId;
};

/** All direct sub-job ids of the given master within the parent map. */
export const getDirectSubJobIds = (masterJobId: string, parentMap: Map<string, string>): string[] => {
  const subs: string[] = [];
  parentMap.forEach((master, sub) => {
    if (master === masterJobId) subs.push(sub);
  });
  return subs;
};

const jobScheduleBounds = (
  schedule: Schedule | null | undefined,
  jobId: string
): { startMs: number; endMs: number } | null => {
  const js = schedule?.jobSchedules?.find((j) => j.jobId === jobId);
  if (!js) return null;
  const startMs = new Date(js.plannedStartDate as unknown as string | Date).getTime();
  const endMs = new Date(js.plannedEndDate as unknown as string | Date).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return { startMs, endMs };
};

export interface MasterDropClamp {
  /** The clamped start (ms) — never before any scheduled sub-job's end. */
  clampedStartMs: number;
  /** The sub-job that forced the clamp, when one did. */
  blockingSubJobId: string | null;
}

/**
 * When manually placing a MASTER job, its start may not precede the latest
 * end of its already-scheduled sub-jobs. Returns the (possibly unchanged)
 * start plus which sub-job forced the clamp.
 */
export const clampMasterDropStart = (
  jobId: string,
  proposedStartMs: number,
  parentMap: Map<string, string>,
  schedule: Schedule | null | undefined
): MasterDropClamp => {
  let clampedStartMs = proposedStartMs;
  let blockingSubJobId: string | null = null;

  for (const subId of getDirectSubJobIds(jobId, parentMap)) {
    const bounds = jobScheduleBounds(schedule, subId);
    if (bounds && bounds.endMs > clampedStartMs) {
      clampedStartMs = bounds.endMs;
      blockingSubJobId = subId;
    }
  }

  return { clampedStartMs, blockingSubJobId };
};

/**
 * Post-placement dependency check for manual moves. Returns a human-readable
 * warning when the placement of `jobId` at [startMs, endMs] breaks the
 * "sub-jobs finish before the master starts" rule against the current
 * schedule, or null when the placement is fine.
 */
export const describeDependencyViolation = (
  jobId: string,
  startMs: number,
  endMs: number,
  parentMap: Map<string, string>,
  schedule: Schedule | null | undefined
): string | null => {
  // As a sub-job: must end before its master starts.
  const masterId = parentMap.get(jobId);
  if (masterId) {
    const master = jobScheduleBounds(schedule, masterId);
    if (master && endMs > master.startMs) {
      return `${jobId} feeds master job ${masterId} but now ends after the master starts — reschedule ${masterId} later or move ${jobId} earlier`;
    }
  }

  // As a master: must start after every scheduled sub-job ends.
  for (const subId of getDirectSubJobIds(jobId, parentMap)) {
    const sub = jobScheduleBounds(schedule, subId);
    if (sub && startMs < sub.endMs) {
      return `Master job ${jobId} now starts before sub-job ${subId} finishes — sub-jobs must complete first`;
    }
  }

  return null;
};

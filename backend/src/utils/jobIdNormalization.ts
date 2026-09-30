/**
 * Job-ID canonicalisation for SYSPRO master/sub-job links.
 *
 * SYSPRO stores Job keys as fixed-width strings that are often zero-padded
 * (e.g. "000000000012345"), but the master link can surface in a different
 * format depending on the source: unpadded ("12345"), space-padded (char
 * columns), or via the APS/LYNQ compat views which LTRIM/RTRIM. The engine,
 * the CP-SAT payload builder and completeJobFamilies all compare masterJobId
 * to jobId with plain string equality, so any format mismatch silently
 * disables dependency scheduling — the master is scheduled as if it had no
 * sub-jobs, with no warning.
 *
 * resolveMasterLinks() fixes this at load time: it rewrites every
 * job.masterJobId to the EXACT jobId string of the loaded job it refers to,
 * so every downstream comparison is plain equality. Links that point at jobs
 * not in the loaded set (e.g. a completed master) are kept trimmed but
 * untouched — the engine already ignores masters outside the run.
 */
import { Job } from '../types';

type LinkedJob = Job & {
  masterJobId?: string | null;
  isMasterJob?: boolean;
  isSubJob?: boolean;
};

/**
 * Canonical comparison key for a SYSPRO job id:
 * - trims whitespace (char-column padding)
 * - purely numeric ids lose their leading zeros ("000123" ≡ "123")
 * - alphanumeric ids compare case-insensitively
 */
export const canonicalJobKey = (id: unknown): string => {
  const text = String(id ?? '').trim();
  if (!text) return '';
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : text.toUpperCase();
};

export interface MasterLinkResolution {
  /** Links rewritten to a loaded job's exact id (format differed). */
  resolved: number;
  /** Self-referencing links cleared. */
  selfCleared: number;
  /** Links whose master is not among the loaded jobs (left as trimmed text). */
  unresolved: number;
}

/**
 * Normalise every job's masterJobId in place so it matches the exact jobId
 * string of the loaded master job. Also repairs the isMasterJob/isSubJob
 * flags for resolved pairs (they may be missing on the APS-views path).
 */
export const resolveMasterLinks = (jobs: Job[]): MasterLinkResolution => {
  const result: MasterLinkResolution = { resolved: 0, selfCleared: 0, unresolved: 0 };
  if (!jobs.length) return result;

  const byCanonical = new Map<string, LinkedJob>();
  for (const job of jobs as LinkedJob[]) {
    const key = canonicalJobKey(job.jobId);
    if (key && !byCanonical.has(key)) byCanonical.set(key, job);
  }

  for (const job of jobs as LinkedJob[]) {
    const raw = String(job.masterJobId ?? '').trim();
    // Punctuation-only / all-zero values (e.g. "," from a duplicated column) are no link.
    if (!raw || !/[A-Za-z0-9]/.test(raw) || /^0+$/.test(raw)) {
      job.masterJobId = null;
      continue;
    }

    const linkKey = canonicalJobKey(raw);
    if (linkKey === canonicalJobKey(job.jobId)) {
      // Malformed self-reference — a job cannot be its own master.
      job.masterJobId = null;
      result.selfCleared++;
      continue;
    }

    const master = byCanonical.get(linkKey);
    if (!master) {
      // Master not in the loaded set (completed/closed job). Keep the trimmed
      // value for display; the engine ignores out-of-run masters.
      job.masterJobId = raw;
      result.unresolved++;
      continue;
    }

    if (job.masterJobId !== master.jobId) result.resolved++;
    job.masterJobId = master.jobId;
    job.isSubJob = true;
    master.isMasterJob = true;
  }

  return result;
};

/**
 * Master/sub-job family analysis for the Job Tree tab.
 *
 * Pure functions: given the loaded jobs, the sub→master parent map
 * (utils/masterSub.buildParentMap) and the current schedule, produce a
 * recursive tree of the family with per-job dates/KPIs plus family-level
 * KPIs — including which job and which operation is the bottleneck.
 *
 * Bottleneck semantics (mirrors the engine rule "all sub-jobs must finish
 * before the master starts"):
 *  - The GATING (bottleneck) child of any job is the child with the LATEST
 *    end date — it alone determines the earliest start of its parent.
 *  - The CRITICAL CHAIN is the path from the root master down through each
 *    gating child; shortening anything off this chain cannot pull the
 *    master's start earlier.
 *  - The BOTTLENECK OPERATION is the longest operation (setup + run) on the
 *    critical chain.
 */
import type { Job, Schedule } from '../types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LongestOp {
  opId: string;
  workcentreId: string;
  minutes: number;
}

export interface JobNodeAnalysis {
  jobId: string;
  /** null when the master is referenced but not among the loaded jobs. */
  job: Job | null;
  depth: number;
  children: JobNodeAnalysis[];
  scheduled: boolean;
  /** Effective window: scheduled dates, else SYSPRO planned dates, else null. */
  startMs: number | null;
  endMs: number | null;
  dateSource: 'scheduled' | 'syspro' | 'none';
  dueMs: number | null;
  /** endMs − dueMs; positive = late. Null when either side is unknown. */
  latenessMs: number | null;
  opsCount: number;
  scheduledOpsCount: number;
  /** Σ (setup + run) minutes over the job's routing. */
  workMinutes: number;
  longestOp: LongestOp | null;
  /** True for every job on the critical chain (root included). */
  onCriticalChain: boolean;
  /** True for the child that gates its direct parent's start. */
  isGatingJob: boolean;
}

export interface FamilyViolation {
  subId: string;
  masterId: string;
  /** How far the sub-job's end overruns the master's start (ms, > 0). */
  overlapMs: number;
}

export interface FamilyAnalysis {
  masterId: string;
  root: JobNodeAnalysis;
  jobCount: number;
  scheduledCount: number;
  familyStartMs: number | null;
  familyEndMs: number | null;
  totalWorkMinutes: number;
  masterDueMs: number | null;
  /** Master end − master due; positive = family delivers late. */
  masterLatenessMs: number | null;
  /** The direct child of the root that gates the master's start. */
  bottleneckJobId: string | null;
  /** master start − gating child end. Negative = precedence violated. */
  bottleneckSlackMs: number | null;
  /** Longest operation on the critical chain. */
  bottleneckOp: (LongestOp & { jobId: string }) | null;
  /** Workcentre carrying the most work minutes across the family. */
  topWorkcentre: { workcentreId: string; minutes: number } | null;
  violations: FamilyViolation[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const toMs = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const ms = new Date(value as string | number | Date).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const buildChildrenMap = (parentMap: Map<string, string>): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  parentMap.forEach((master, sub) => {
    const list = map.get(master) || [];
    list.push(sub);
    map.set(master, list);
  });
  // Stable order: alphabetical, so the tree doesn't jump between renders.
  map.forEach((list) => list.sort((a, b) => a.localeCompare(b)));
  return map;
};

/**
 * Roots of every master/sub family that is worth showing: jobs referenced as
 * a master by at least one loaded job, and not themselves a sub of another
 * loaded family member (nested masters appear inside their parent's tree).
 */
export const listFamilyRoots = (
  jobs: Job[],
  parentMap: Map<string, string>
): string[] => {
  const loadedIds = new Set(jobs.map((j) => j.jobId));
  const masters = new Set<string>(Array.from(parentMap.values()));
  const roots: string[] = [];
  masters.forEach((masterId) => {
    const ownParent = parentMap.get(masterId);
    // A master is a root when it has no parent, or its parent isn't loaded.
    if (!ownParent || (!loadedIds.has(ownParent) && !masters.has(ownParent))) {
      roots.push(masterId);
    }
  });
  return roots.sort((a, b) => a.localeCompare(b));
};

// ── Analysis ──────────────────────────────────────────────────────────────────

export const analyzeFamily = (
  masterId: string,
  jobs: Job[],
  parentMap: Map<string, string>,
  schedule: Schedule | null | undefined
): FamilyAnalysis => {
  const jobsById = new Map(jobs.map((j) => [j.jobId, j]));
  const childrenMap = buildChildrenMap(parentMap);
  const scheduleById = new Map(
    (schedule?.jobSchedules ?? []).map((js) => [js.jobId, js])
  );

  const violations: FamilyViolation[] = [];
  const wcMinutes = new Map<string, number>();
  let jobCount = 0;
  let scheduledCount = 0;
  let totalWorkMinutes = 0;
  let familyStartMs: number | null = null;
  let familyEndMs: number | null = null;

  const buildNode = (jobId: string, depth: number, seen: Set<string>): JobNodeAnalysis => {
    seen.add(jobId);
    jobCount++;

    const job = jobsById.get(jobId) ?? null;
    const js = scheduleById.get(jobId);
    const scheduled = !!js?.operationSchedules?.length;
    if (scheduled) scheduledCount++;

    let startMs: number | null = null;
    let endMs: number | null = null;
    let dateSource: JobNodeAnalysis['dateSource'] = 'none';
    if (scheduled && js) {
      startMs = toMs(js.plannedStartDate);
      endMs = toMs(js.plannedEndDate);
      dateSource = 'scheduled';
    } else if (job) {
      startMs = toMs(job.releaseDate);
      endMs = toMs(job.dueDate);
      dateSource = startMs !== null || endMs !== null ? 'syspro' : 'none';
    }

    const dueMs = job ? toMs(job.dueDate) : null;
    const latenessMs = endMs !== null && dueMs !== null ? endMs - dueMs : null;

    const operations = job?.operations ?? [];
    let workMinutes = 0;
    let longestOp: LongestOp | null = null;
    for (const op of operations) {
      const minutes = Math.max(0, Number(op.setupTime) || 0) + Math.max(0, Number(op.duration) || 0);
      workMinutes += minutes;
      const wc = String(op.workcentreId || 'WC-UNKNOWN');
      wcMinutes.set(wc, (wcMinutes.get(wc) || 0) + minutes);
      if (!longestOp || minutes > longestOp.minutes) {
        longestOp = { opId: String(op.opId), workcentreId: wc, minutes };
      }
    }
    totalWorkMinutes += workMinutes;

    if (startMs !== null && (familyStartMs === null || startMs < familyStartMs)) familyStartMs = startMs;
    if (endMs !== null && (familyEndMs === null || endMs > familyEndMs)) familyEndMs = endMs;

    const children = (childrenMap.get(jobId) || [])
      .filter((childId) => !seen.has(childId)) // cycle-safe
      .map((childId) => buildNode(childId, depth + 1, seen));

    const node: JobNodeAnalysis = {
      jobId,
      job,
      depth,
      children,
      scheduled,
      startMs,
      endMs,
      dateSource,
      dueMs,
      latenessMs,
      opsCount: operations.length,
      scheduledOpsCount: js?.operationSchedules?.length ?? 0,
      workMinutes,
      longestOp,
      onCriticalChain: false,
      isGatingJob: false,
    };

    // Precedence violations: a scheduled child ending after this job starts.
    if (startMs !== null && dateSource === 'scheduled') {
      for (const child of children) {
        if (child.dateSource === 'scheduled' && child.endMs !== null && child.endMs > startMs) {
          violations.push({ subId: child.jobId, masterId: jobId, overlapMs: child.endMs - startMs });
        }
      }
    }

    return node;
  };

  const root = buildNode(masterId, 0, new Set<string>());

  // ── Critical chain: descend through the child with the latest end. ─────────
  const markCriticalChain = (node: JobNodeAnalysis): void => {
    node.onCriticalChain = true;
    if (!node.children.length) return;
    let gating: JobNodeAnalysis | null = null;
    for (const child of node.children) {
      if (child.endMs === null) continue;
      if (!gating || gating.endMs === null || child.endMs > gating.endMs) gating = child;
    }
    // All children undated → fall back to most work.
    if (!gating) {
      gating = node.children.reduce((best, c) => (c.workMinutes > best.workMinutes ? c : best), node.children[0]);
    }
    gating.isGatingJob = true;
    markCriticalChain(gating);
  };
  markCriticalChain(root);

  const gatingChild = root.children.find((c) => c.isGatingJob) ?? null;
  const bottleneckSlackMs =
    gatingChild && root.startMs !== null && gatingChild.endMs !== null && root.dateSource === 'scheduled' && gatingChild.dateSource === 'scheduled'
      ? root.startMs - gatingChild.endMs
      : null;

  // Bottleneck operation: longest op across the critical chain (root included —
  // the master's own longest op can dominate the family lead time too).
  let bottleneckOp: FamilyAnalysis['bottleneckOp'] = null;
  const walkChain = (node: JobNodeAnalysis): void => {
    if (node.longestOp && (!bottleneckOp || node.longestOp.minutes > bottleneckOp.minutes)) {
      bottleneckOp = { ...node.longestOp, jobId: node.jobId };
    }
    const next = node.children.find((c) => c.isGatingJob);
    if (next) walkChain(next);
  };
  walkChain(root);

  let topWorkcentre: FamilyAnalysis['topWorkcentre'] = null;
  wcMinutes.forEach((minutes, workcentreId) => {
    if (!topWorkcentre || minutes > topWorkcentre.minutes) topWorkcentre = { workcentreId, minutes };
  });

  const masterDueMs = root.dueMs;
  const masterLatenessMs =
    root.endMs !== null && masterDueMs !== null ? root.endMs - masterDueMs : null;

  return {
    masterId,
    root,
    jobCount,
    scheduledCount,
    familyStartMs,
    familyEndMs,
    totalWorkMinutes,
    masterDueMs,
    masterLatenessMs,
    bottleneckJobId: gatingChild?.jobId ?? null,
    bottleneckSlackMs,
    bottleneckOp,
    topWorkcentre,
    violations,
  };
};

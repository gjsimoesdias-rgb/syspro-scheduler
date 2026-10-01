/**
 * Schedule diagnostics for the jobs grid — pure functions over the current
 * schedule and the loaded jobs (extracted from App.tsx). Hook wrapper:
 * hooks/useScheduleDiagnostics.ts.
 */
import type { Job, JobSchedule, Schedule } from '../types';

export type Lateness = 'late' | 'at-risk' | 'on-time';
export type JobScheduleStatus = 'scheduled' | 'partial' | 'not-scheduled';
export interface ScheduleShortfall {
  tipByJob: Map<string, string>;
  jobCount: number;
  opCount: number;
  topWc: Array<[string, number]>;
}

const AT_RISK_MS = 8 * 60 * 60 * 1000;

export function scheduleByJobId(schedule: Schedule | null | undefined): Map<string, JobSchedule> {
  const map = new Map<string, JobSchedule>();
  for (const js of schedule?.jobSchedules ?? []) map.set(js.jobId, js);
  return map;
}

/** Scheduled end vs due date. Unscheduled jobs are left out (their "end" is the due date). */
export function jobLateness(schedule: Schedule | null | undefined, jobs: Job[]): Map<string, Lateness> {
  const map = new Map<string, Lateness>();
  const jobById = new Map(jobs.map((j) => [j.jobId, j] as const));
  for (const js of schedule?.jobSchedules ?? []) {
    if (!js.operationSchedules?.length) continue;
    const job = jobById.get(js.jobId);
    if (!job?.dueDate) { map.set(js.jobId, 'on-time'); continue; }
    const end = new Date(js.plannedEndDate).getTime();
    const due = new Date(job.dueDate).getTime();
    if (Number.isNaN(end) || Number.isNaN(due)) { map.set(js.jobId, 'on-time'); continue; }
    const diff = end - due;
    map.set(js.jobId, diff > 0 ? 'late' : diff > -AT_RISK_MS ? 'at-risk' : 'on-time');
  }
  return map;
}

export const fmtSpan = (min: number): string => {
  const m = Math.max(0, Math.round(min));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
};

/**
 * Why each late job is late, from the engine's per-operation explanation
 * (readyAt / waitMinutes / waitReason / blockedBy).
 */
export function lateReasons(
  schedule: Schedule | null | undefined,
  jobs: Job[],
  lateness: Map<string, Lateness>,
  fmtDate: (d: Date) => string = (d) =>
    d.toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
): Map<string, string> {
  const out = new Map<string, string>();
  const jobById = new Map(jobs.map((j) => [j.jobId, j] as const));
  for (const js of schedule?.jobSchedules ?? []) {
    if (lateness.get(js.jobId) !== 'late') continue;
    const job = jobById.get(js.jobId);
    const due = job?.dueDate ? new Date(job.dueDate) : null;
    if (!due || Number.isNaN(due.getTime())) continue;
    const end = new Date(js.plannedEndDate);
    const lines = [`Finishes ${fmtSpan((end.getTime() - due.getTime()) / 60000)} after the due date (${fmtDate(due)}).`];
    const ops = (js.operationSchedules || []) as any[];
    const firstReady = ops[0]?.readyAt ? new Date(ops[0].readyAt) : null;
    if (firstReady && firstReady.getTime() >= due.getTime()) {
      lines.push(`The due date had already passed when the job could start (ready ${fmtDate(firstReady)}).`);
    }
    let lineMin = 0; let calMin = 0; let crewMin = 0; const behind = new Set<string>();
    for (const o of ops) {
      const w = Number(o.waitMinutes) || 0;
      if (w <= 0) continue;
      if (o.waitReason === 'calendar') calMin += w;
      else if (o.waitReason === 'crew') crewMin += w;
      else lineMin += w;
      for (const b of o.blockedBy || []) behind.add(String(b).replace(/^0+/, ''));
    }
    if (lineMin > 0) lines.push(`Waited ${fmtSpan(lineMin)} for busy lines${behind.size ? ` (behind ${[...behind].slice(0, 6).join(', ')})` : ''}.`);
    if (crewMin > 0) lines.push(`Waited ${fmtSpan(crewMin)} for free operators in its crew.`);
    if (calMin > 0) lines.push(`Waited ${fmtSpan(calMin)} for shift time.`);
    if (lines.length === 1 && !ops.some((o) => 'readyAt' in o)) lines.push('Regenerate to see what delayed it.');
    out.set(js.jobId, lines.join('\n'));
  }
  return out;
}

export function jobScheduleStatus(job: Job, byJob: Map<string, JobSchedule>): JobScheduleStatus {
  const js = byJob.get(job.jobId);
  if (!js) return 'not-scheduled';
  const total = job.operations.length;
  const placed = js.operationSchedules?.length ?? 0;
  if (placed >= total && total > 0) return 'scheduled';
  if (placed > 0) return 'partial';
  return 'not-scheduled';
}

const HUMAN_VIOLATION: Record<string, string> = {
  CapacityExceeded: 'no capacity in window',
  OvertimeExceeded: 'over shift capacity',
  ScheduleDateViolation: 'outside horizon',
  SkillMismatch: 'no qualified machine',
  LineGroupViolation: 'line-group conflict',
  SetupConflict: 'setup conflict',
  BatchViolation: 'batch rule',
};
const PLACEMENT_TYPES = new Set(Object.keys(HUMAN_VIOLATION));

/**
 * Why jobs didn't fully fit the last run: joins each placement violation to
 * its operation to name the work centre, giving a per-job hover tip and the
 * bottleneck counts. Info-severity notes (e.g. "finishes after the planning
 * window") are not drops and are ignored.
 */
export function scheduleShortfall(schedule: Schedule | null | undefined, jobs: Job[]): ScheduleShortfall | null {
  const violations = schedule?.constraintViolations;
  if (!violations || violations.length === 0) return null;

  const opMap = new Map<string, { wc: string; seq: number }>();
  for (const j of jobs) {
    for (const op of j.operations || []) {
      opMap.set(op.opId, { wc: op.workcentreName || op.workcentreId, seq: op.sequence });
    }
  }

  const reasonsByJob = new Map<string, string[]>();
  const wcCounts = new Map<string, number>();
  const jobIds = new Set<string>();
  let opCount = 0;

  for (const v of violations) {
    if (!PLACEMENT_TYPES.has(v.type)) continue;
    if (v.severity === 'Info') continue;
    opCount++;
    const info = v.affectedOperationId ? opMap.get(v.affectedOperationId) : undefined;
    const wc = info?.wc || 'work centre';
    if (v.type === 'CapacityExceeded' || v.type === 'OvertimeExceeded') {
      wcCounts.set(wc, (wcCounts.get(wc) || 0) + 1);
    }
    const jid = v.affectedJobId;
    if (jid) {
      jobIds.add(jid);
      const label = info ? `Op ${info.seq} — ${wc}` : (v.description || v.type);
      const line = `${label} (${HUMAN_VIOLATION[v.type] ?? v.type})`;
      const arr = reasonsByJob.get(jid) || [];
      if (!arr.includes(line)) arr.push(line);
      reasonsByJob.set(jid, arr);
    }
  }
  if (opCount === 0) return null;

  const tipByJob = new Map<string, string>();
  for (const [jid, arr] of reasonsByJob) tipByJob.set(jid, `Couldn't fit in this schedule:\n• ${arr.join('\n• ')}`);
  const topWc = [...wcCounts.entries()].sort((a, b) => b[1] - a[1]);
  return { tipByJob, jobCount: jobIds.size, opCount, topWc };
}

/**
 * Per-job publish status (phase 5) — what was last sent to SYSPRO for each
 * job, so "Send to SYSPRO" only writes jobs whose dates or machines changed,
 * and every job can show Published / Pending / Error.
 *
 * Stored in aps.JobPublishStatus (created on connect by ensureSysproObjects).
 */
import { createHash } from 'crypto';
import type { DbExecutor } from '../database/connection';
import { isSuggestedJobId } from '../utils/suggestedJobs';

export type PublishState = 'Published' | 'Pending' | 'Error';

const iso = (d: unknown): string => {
  const t = new Date(d as any);
  return Number.isNaN(t.getTime()) ? '' : t.toISOString().slice(0, 16); // minute precision
};

/** Hash of everything the export writes for a job: op machine + dates, job dates. */
export function jobFingerprint(job: any): string {
  const ops = [...(job?.operationSchedules || [])]
    .map((op: any) => [
      String(op.opId ?? ''),
      String(op.resourceId || op.workcentreId || ''),
      iso(op.plannedStartDate), iso(op.plannedEndDate), iso(op.runStart || op.plannedStartDate),
    ])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const payload = JSON.stringify([iso(job?.plannedStartDate), iso(job?.plannedEndDate), ops]);
  return createHash('sha256').update(payload).digest('hex');
}

export interface PublishRow { jobId: string; status: string; fingerprint: string | null; publishedAt: Date | null; lastError: string | null; }

export async function loadPublishRows(db: DbExecutor): Promise<Map<string, PublishRow>> {
  const r = await db.query(`
    IF OBJECT_ID('aps.JobPublishStatus', 'U') IS NULL SELECT TOP 0 CAST('' AS nvarchar(30)) AS JobId;
    ELSE SELECT JobId, Status, Fingerprint, PublishedAt, LastError FROM aps.JobPublishStatus`);
  const map = new Map<string, PublishRow>();
  for (const row of r.recordset || []) {
    map.set(String(row.JobId).trim(), {
      jobId: String(row.JobId).trim(), status: row.Status, fingerprint: row.Fingerprint ?? null,
      publishedAt: row.PublishedAt ?? null, lastError: row.LastError ?? null,
    });
  }
  return map;
}

/** Jobs to send: those with operations whose fingerprint differs from the last publish (or all, when `full`). */
export function planPublish(schedule: any, rows: Map<string, PublishRow>, full = false): {
  toPublish: any[]; unchanged: string[];
} {
  const toPublish: any[] = [];
  const unchanged: string[] = [];
  for (const job of schedule?.jobSchedules || []) {
    if (!job?.operationSchedules?.length) continue;
    if (isSuggestedJobId(job.jobId)) continue; // MRP suggestions are not SYSPRO jobs yet
    const prev = rows.get(String(job.jobId).trim());
    if (!full && prev?.status === 'Published' && prev.fingerprint === jobFingerprint(job)) {
      unchanged.push(job.jobId);
    } else {
      toPublish.push(job);
    }
  }
  return { toPublish, unchanged };
}

/** Status of every job in `schedule` against what was last published. */
export function publishStateFor(schedule: any, rows: Map<string, PublishRow>): Array<{
  jobId: string; state: PublishState; publishedAt: Date | null; lastError: string | null;
}> {
  return (schedule?.jobSchedules || [])
    .filter((j: any) => j?.operationSchedules?.length && !isSuggestedJobId(j.jobId))
    .map((job: any) => {
      const prev = rows.get(String(job.jobId).trim());
      const state: PublishState = prev?.status === 'Error'
        ? 'Error'
        : prev?.status === 'Published' && prev.fingerprint === jobFingerprint(job) ? 'Published' : 'Pending';
      return { jobId: job.jobId, state, publishedAt: prev?.publishedAt ?? null, lastError: state === 'Error' ? prev?.lastError ?? null : null };
    });
}

const UPSERT = `
  MERGE aps.JobPublishStatus WITH (HOLDLOCK) AS t
  USING (SELECT @jobId AS JobId) AS s ON t.JobId = s.JobId
  WHEN MATCHED THEN UPDATE SET ScheduleId = @scheduleId, Status = @status, PlannedStart = @start, PlannedEnd = @end,
    Fingerprint = @fp, PublishedAt = CASE WHEN @status = 'Published' THEN GETDATE() ELSE t.PublishedAt END,
    PublishedBy = CASE WHEN @status = 'Published' THEN @user ELSE t.PublishedBy END,
    LastError = @error, UpdatedAt = GETDATE()
  WHEN NOT MATCHED THEN INSERT (JobId, ScheduleId, Status, PlannedStart, PlannedEnd, Fingerprint, PublishedAt, PublishedBy, LastError)
    VALUES (@jobId, @scheduleId, @status, @start, @end, @fp,
            CASE WHEN @status = 'Published' THEN GETDATE() ELSE NULL END,
            CASE WHEN @status = 'Published' THEN @user ELSE NULL END, @error);`;

const toDate = (v: unknown) => { const d = new Date(v as any); return Number.isNaN(d.getTime()) ? null : d; };

export async function recordPublished(db: DbExecutor, jobs: any[], scheduleId: string, user?: string): Promise<void> {
  for (const job of jobs) {
    await db.queryWithParams(UPSERT, {
      jobId: String(job.jobId).trim().slice(0, 30), scheduleId, status: 'Published',
      start: toDate(job.plannedStartDate), end: toDate(job.plannedEndDate),
      fp: jobFingerprint(job), user: user ?? null, error: null,
    });
  }
}

export async function recordError(db: DbExecutor, job: any, scheduleId: string, error: string): Promise<void> {
  await db.queryWithParams(UPSERT, {
    jobId: String(job.jobId).trim().slice(0, 30), scheduleId, status: 'Error',
    start: toDate(job.plannedStartDate), end: toDate(job.plannedEndDate),
    fp: null, user: null, error: error.slice(0, 1000),
  });
}

/** Forget the last publish for these jobs so the next send includes them. */
export async function resetPublish(db: DbExecutor, jobIds: string[]): Promise<number> {
  let n = 0;
  for (const jobId of jobIds) {
    const r = await db.queryWithParams(
      `DELETE FROM aps.JobPublishStatus WHERE JobId = @jobId; SELECT @@ROWCOUNT AS n;`, { jobId: jobId.trim() });
    n += Number(r.recordset?.[0]?.n || 0);
  }
  return n;
}

/** Which job an export error message is about, when it names one. */
export function jobIdFromExportError(message: string, jobIds: string[]): string | null {
  for (const id of jobIds) {
    if (message.includes(String(id).trim())) return id;
  }
  return null;
}

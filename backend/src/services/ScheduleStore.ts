/**
 * ScheduleStore — the only code that writes aps.SavedSchedules' "latest" row.
 *
 * Every write that changes which schedule is latest runs in ONE transaction.
 * Previously generate / save / load-version / scenario-promote each ran
 * "UPDATE IsLatest = 0" and the INSERT as separate statements: a failure in
 * between left NO latest schedule, so the Gantt came up empty after a reload.
 */
import type { DbExecutor } from '../database/connection';
import type { PlanExecutor } from './planStore';

export interface SaveLatestOptions {
  status?: string;
  generatedAt?: Date;
  /** Shown in the Versions list; defaults to "Plan <date time>". */
  versionName?: string;
  createdBy?: string;
  /** Version this plan was derived from (e.g. the what-if it was committed from). */
  basedOnId?: string | null;
  /**
   * Optimistic concurrency: the master revision the caller's board was based
   * on. undefined = don't check (server-side runs such as Generate); null =
   * the caller believes there is no master yet. A mismatch throws 409.
   */
  baseRevision?: number | null;
}

/** Next master revision (call inside the write transaction). */
async function nextRevision(tx: DbExecutor): Promise<number> {
  const r = await tx.query(`SELECT ISNULL(MAX(Revision), 0) + 1 AS n FROM aps.SavedSchedules WITH (UPDLOCK, HOLDLOCK)`);
  return Number(r.recordset?.[0]?.n) || 1;
}

/** Revision of the current master (null when there is none). */
export async function masterRevision(db: DbExecutor): Promise<number | null> {
  const r = await db.query(`SELECT TOP 1 Revision FROM aps.SavedSchedules WHERE IsLatest = 1 ORDER BY SavedAt DESC`);
  const row = r.recordset?.[0];
  return row ? Number(row.Revision) || 0 : null;
}

export const MASTER_CHANGED = 'MASTER_CHANGED';


/** Compact KPI snapshot stored per version so the list/compare view never parses ScheduleData. */
export const metricsSnapshot = (schedule: any): string | null => {
  const m = schedule?.metrics;
  if (!m) return null;
  const keep = [
    'totalJobsScheduled', 'jobsUnscheduled', 'jobsOnTime', 'jobsTardy', 'averageTardiness', 'otdRate',
    'resourceUtilization', 'totalOvertimeHours', 'makespan', 'avgLeadTimeDays',
    'operatingHours', 'busyHours', 'productiveHours', 'directDowntimeHours', 'idleHours',
    'busyPct', 'productivePct', 'directDowntimePct', 'idlePct',
  ];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (m[k] !== undefined) out[k] = m[k];
  out.violations = Array.isArray(schedule?.constraintViolations) ? schedule.constraintViolations.length : 0;
  return JSON.stringify(out);
};

// Server local time (the plant's clock), not UTC.
const defaultName = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Plan ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const countOps = (schedule: any): number =>
  (schedule?.jobSchedules ?? []).reduce(
    (sum: number, j: any) => sum + (j?.operationSchedules?.length || 0),
    0
  );

const toDateOrNull = (v: unknown): Date | null => {
  if (!v) return null;
  const d = new Date(v as any);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Insert/replace `schedule` and make it the single latest row, atomically. */
export async function saveAsLatest(
  db: PlanExecutor,
  schedule: any,
  opts: SaveLatestOptions = {}
): Promise<{ scheduleId: string; jobCount: number; operationCount: number; revision: number }> {
  const jobCount = schedule?.jobSchedules?.length || 0;
  const operationCount = countOps(schedule);
  let revision = 0;

  await db.withTransaction(async (tx: DbExecutor) => {
    if (opts.baseRevision !== undefined) {
      const cur = await tx.query(
        `SELECT TOP 1 Revision FROM aps.SavedSchedules WITH (UPDLOCK, HOLDLOCK) WHERE IsLatest = 1 ORDER BY SavedAt DESC`);
      const row = cur.recordset?.[0];
      const current = row ? Number(row.Revision) || 0 : null;
      if (current !== opts.baseRevision) {
        throw Object.assign(new VersionError(
          'The master plan was changed (by another planner, another tab, Versions or Generate) since this board was loaded. ' +
          'Your changes were not saved — reopen the master plan to continue.', 409), { code: MASTER_CHANGED, currentRevision: current });
      }
    }
    revision = await nextRevision(tx);
    await tx.query(`UPDATE aps.SavedSchedules SET IsLatest = 0 WHERE IsLatest = 1`);
    await tx.queryWithParams(
      `DELETE FROM aps.SavedSchedules WHERE ScheduleID = @scheduleId`,
      { scheduleId: schedule.scheduleId }
    );
    await tx.queryWithParams(
      `INSERT INTO aps.SavedSchedules
         (ScheduleID, ScheduleData, Status, JobCount, OperationCount,
          HorizonStart, HorizonEnd, GeneratedAt, SavedAt, IsLatest,
          VersionKind, VersionName, BasedOnId, CreatedBy, MetricsJson, Revision)
       VALUES
         (@scheduleId, @scheduleData, @status, @jobCount, @opCount,
          @horizonStart, @horizonEnd, @generatedAt, GETDATE(), 1,
          'Plan', @versionName, @basedOnId, @createdBy, @metricsJson, @revision)`,
      {
        revision,
        versionName: (opts.versionName || schedule?.versionName || defaultName()).slice(0, 120),
        basedOnId: opts.basedOnId ?? null,
        createdBy: opts.createdBy ?? null,
        metricsJson: metricsSnapshot(schedule),
        scheduleId: schedule.scheduleId,
        scheduleData: JSON.stringify(stripClientFields(schedule)),
        status: opts.status || schedule?.status || 'Draft',
        jobCount,
        opCount: operationCount,
        horizonStart: toDateOrNull(schedule?.planningHorizon?.startDate),
        horizonEnd: toDateOrNull(schedule?.planningHorizon?.endDate),
        generatedAt: opts.generatedAt || toDateOrNull(schedule?.scheduledDate) || new Date(),
      }
    );
  });

  return { scheduleId: schedule.scheduleId, jobCount, operationCount, revision };
}

/** Fields the API adds to a schedule on the way out that must not be stored inside it. */
const stripClientFields = (schedule: any) => {
  if (!schedule || typeof schedule !== 'object' || !('masterRevision' in schedule)) return schedule;
  const { masterRevision: _r, ...rest } = schedule;
  return rest;
};

/** Make an existing saved schedule the latest one, atomically. Returns false if it doesn't exist. */
export async function promoteToLatest(db: PlanExecutor, scheduleId: string): Promise<boolean> {
  return db.withTransaction(async (tx: DbExecutor) => {
    const exists = await tx.queryWithParams(
      `SELECT 1 AS ok FROM aps.SavedSchedules WHERE ScheduleID = @scheduleId`,
      { scheduleId }
    );
    if (!exists.recordset?.length) return false;
    const revision = await nextRevision(tx);
    await tx.query(`UPDATE aps.SavedSchedules SET IsLatest = 0 WHERE IsLatest = 1`);
    await tx.queryWithParams(
      `UPDATE aps.SavedSchedules SET IsLatest = 1, Revision = @revision WHERE ScheduleID = @scheduleId`,
      { scheduleId, revision }
    );
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Plan versions (phase 5)
//
//   Master  = the IsLatest row (what the Gantt, dispatch and export use)
//   History = earlier masters (VersionKind 'Plan', IsLatest 0)
//   What-if = VersionKind 'WhatIf' — never latest until committed
// ─────────────────────────────────────────────────────────────────────────

export interface VersionSummary {
  versionId: string;
  kind: 'Master' | 'History' | 'WhatIf';
  name: string;
  status: string;
  jobCount: number | null;
  operationCount: number | null;
  horizonStart: Date | null;
  horizonEnd: Date | null;
  savedAt: Date;
  createdBy: string | null;
  basedOnId: string | null;
  metrics: Record<string, any> | null;
}

// SavedAt is written with GETDATE() (server local time, no offset). Attach the
// server's offset so the driver returns the real instant, not local-as-UTC.
const SUMMARY_COLS = `ScheduleID, Status, JobCount, OperationCount, HorizonStart, HorizonEnd,
  TODATETIMEOFFSET(SavedAt, DATEPART(TZOFFSET, SYSDATETIMEOFFSET())) AS SavedAt,
  IsLatest, VersionKind, VersionName, BasedOnId, CreatedBy, MetricsJson`;

const toSummary = (r: any): VersionSummary => {
  let metrics: Record<string, any> | null = null;
  try { metrics = r.MetricsJson ? JSON.parse(r.MetricsJson) : null; } catch { metrics = null; }
  return {
    versionId: r.ScheduleID,
    kind: r.VersionKind === 'WhatIf' ? 'WhatIf' : r.IsLatest ? 'Master' : 'History',
    name: r.VersionName || (r.IsLatest ? 'Master plan' : 'Earlier plan'),
    status: r.Status,
    jobCount: r.JobCount ?? null,
    operationCount: r.OperationCount ?? null,
    horizonStart: r.HorizonStart ?? null,
    horizonEnd: r.HorizonEnd ?? null,
    savedAt: r.SavedAt,
    createdBy: r.CreatedBy ?? null,
    basedOnId: r.BasedOnId ?? null,
    metrics,
  };
};

export async function listVersions(db: DbExecutor, historyLimit = 30): Promise<{
  master: VersionSummary | null; whatIfs: VersionSummary[]; history: VersionSummary[];
}> {
  const limit = Math.max(1, Math.min(500, Math.floor(historyLimit)));
  const r = await db.query(`
    SELECT ${SUMMARY_COLS} FROM aps.SavedSchedules WHERE IsLatest = 1 OR VersionKind = 'WhatIf'
    UNION ALL
    SELECT * FROM (
      SELECT TOP ${limit} ${SUMMARY_COLS} FROM aps.SavedSchedules
      WHERE IsLatest = 0 AND VersionKind <> 'WhatIf' ORDER BY SavedAt DESC
    ) h
    ORDER BY SavedAt DESC`);
  const rows: VersionSummary[] = (r.recordset || []).map(toSummary);

  // Plans saved before versions existed have no KPI snapshot. Backfill the
  // master and what-ifs (a handful of rows) once, so Compare has numbers.
  for (const v of rows.filter((x) => !x.metrics && x.kind !== 'History').slice(0, 10)) {
    try {
      const d = await db.queryWithParams(
        `SELECT ScheduleData FROM aps.SavedSchedules WHERE ScheduleID = @id`, { id: v.versionId });
      const snap = metricsSnapshot(JSON.parse(d.recordset?.[0]?.ScheduleData || 'null'));
      if (!snap) continue;
      await db.queryWithParams(
        `UPDATE aps.SavedSchedules SET MetricsJson = @m WHERE ScheduleID = @id AND MetricsJson IS NULL`,
        { id: v.versionId, m: snap });
      v.metrics = JSON.parse(snap);
    } catch { /* cosmetic — leave the row without KPIs */ }
  }
  return {
    master: rows.find((v: VersionSummary) => v.kind === 'Master') || null,
    whatIfs: rows.filter((v: VersionSummary) => v.kind === 'WhatIf'),
    history: rows.filter((v: VersionSummary) => v.kind === 'History'),
  };
}

export async function getVersion(db: DbExecutor, versionId: string): Promise<{ summary: VersionSummary; schedule: any } | null> {
  const r = await db.queryWithParams(
    `SELECT ${SUMMARY_COLS}, ScheduleData FROM aps.SavedSchedules WHERE ScheduleID = @versionId`,
    { versionId }
  );
  const row = r.recordset?.[0];
  if (!row) return null;
  const schedule = JSON.parse(row.ScheduleData);
  schedule.scheduleId = row.ScheduleID; // migrated scenarios carried their base id
  return { summary: toSummary(row), schedule };
}

export class VersionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** Copy the master (or `fromId`) into a new what-if version. */
export async function createWhatIf(
  db: DbExecutor,
  opts: { name: string; fromId?: string; createdBy?: string; newId: string }
): Promise<VersionSummary> {
  const src = await db.queryWithParams(
    opts.fromId
      ? `SELECT ScheduleID, ScheduleData, JobCount, OperationCount, HorizonStart, HorizonEnd, GeneratedAt, MetricsJson
         FROM aps.SavedSchedules WHERE ScheduleID = @fromId`
      : `SELECT TOP 1 ScheduleID, ScheduleData, JobCount, OperationCount, HorizonStart, HorizonEnd, GeneratedAt, MetricsJson
         FROM aps.SavedSchedules WHERE IsLatest = 1 ORDER BY SavedAt DESC`,
    opts.fromId ? { fromId: opts.fromId } : {}
  );
  const row = src.recordset?.[0];
  if (!row) throw new VersionError(opts.fromId ? 'Source version not found' : 'There is no master plan to copy yet — generate a schedule first', 404);
  const schedule = JSON.parse(row.ScheduleData);
  schedule.scheduleId = opts.newId;
  await db.queryWithParams(
    `INSERT INTO aps.SavedSchedules
       (ScheduleID, ScheduleData, Status, JobCount, OperationCount, HorizonStart, HorizonEnd, GeneratedAt,
        SavedAt, IsLatest, VersionKind, VersionName, BasedOnId, CreatedBy, MetricsJson)
     VALUES
       (@id, @data, 'Draft', @jobCount, @opCount, @hs, @he, @gen, GETDATE(), 0, 'WhatIf', @name, @basedOn, @createdBy, @metrics)`,
    {
      id: opts.newId, data: JSON.stringify(schedule), jobCount: row.JobCount, opCount: row.OperationCount,
      hs: row.HorizonStart, he: row.HorizonEnd, gen: row.GeneratedAt, name: opts.name.slice(0, 120),
      basedOn: row.ScheduleID, createdBy: opts.createdBy ?? null, metrics: row.MetricsJson,
    }
  );
  const created = await getVersion(db, opts.newId);
  return created!.summary;
}

/** Replace a what-if's schedule (e.g. regenerated with other settings, or edited on the board). */
export async function saveIntoWhatIf(db: DbExecutor, versionId: string, schedule: any): Promise<void> {
  const kind = await db.queryWithParams(
    `SELECT VersionKind FROM aps.SavedSchedules WHERE ScheduleID = @versionId`, { versionId });
  const row = kind.recordset?.[0];
  if (!row) throw new VersionError('Version not found', 404);
  if (row.VersionKind !== 'WhatIf') throw new VersionError('Only what-if versions can be saved into; the master is saved by generate/save', 409);
  const copy = { ...schedule, scheduleId: versionId };
  await db.queryWithParams(
    `UPDATE aps.SavedSchedules SET ScheduleData = @data, Status = 'Draft', JobCount = @jobCount,
       OperationCount = @opCount, HorizonStart = @hs, HorizonEnd = @he, GeneratedAt = GETDATE(),
       SavedAt = GETDATE(), MetricsJson = @metrics
     WHERE ScheduleID = @versionId`,
    {
      versionId, data: JSON.stringify(copy), jobCount: copy?.jobSchedules?.length || 0, opCount: countOps(copy),
      hs: toDateOrNull(copy?.planningHorizon?.startDate), he: toDateOrNull(copy?.planningHorizon?.endDate),
      metrics: metricsSnapshot(copy),
    }
  );
}

/** Make a what-if the master. The old master becomes history. Needs re-approval before export. */
export async function commitWhatIf(db: PlanExecutor, versionId: string): Promise<void> {
  await db.withTransaction(async (tx: DbExecutor) => {
    const r = await tx.queryWithParams(
      `SELECT VersionKind FROM aps.SavedSchedules WITH (UPDLOCK) WHERE ScheduleID = @versionId`, { versionId });
    const row = r.recordset?.[0];
    if (!row) throw new VersionError('Version not found', 404);
    if (row.VersionKind !== 'WhatIf') throw new VersionError('Only a what-if version can be committed', 409);
    const revision = await nextRevision(tx);
    await tx.query(`UPDATE aps.SavedSchedules SET IsLatest = 0 WHERE IsLatest = 1`);
    await tx.queryWithParams(
      `UPDATE aps.SavedSchedules SET IsLatest = 1, VersionKind = 'Plan', Status = 'Draft', SavedAt = GETDATE(), Revision = @revision
       WHERE ScheduleID = @versionId`, { versionId, revision });
  });
}

/** Make an earlier master the master again. Needs re-approval before export. */
export async function revertToVersion(db: PlanExecutor, versionId: string): Promise<void> {
  await db.withTransaction(async (tx: DbExecutor) => {
    const r = await tx.queryWithParams(
      `SELECT VersionKind, IsLatest FROM aps.SavedSchedules WITH (UPDLOCK) WHERE ScheduleID = @versionId`, { versionId });
    const row = r.recordset?.[0];
    if (!row) throw new VersionError('Version not found', 404);
    if (row.VersionKind === 'WhatIf') throw new VersionError('Use commit for a what-if version', 409);
    if (row.IsLatest) return;
    const revision = await nextRevision(tx);
    await tx.query(`UPDATE aps.SavedSchedules SET IsLatest = 0 WHERE IsLatest = 1`);
    await tx.queryWithParams(
      `UPDATE aps.SavedSchedules SET IsLatest = 1, Status = 'Draft', SavedAt = GETDATE(), Revision = @revision WHERE ScheduleID = @versionId`,
      { versionId, revision });
  });
}

export async function renameVersion(db: DbExecutor, versionId: string, name: string): Promise<boolean> {
  const r = await db.queryWithParams(
    `UPDATE aps.SavedSchedules SET VersionName = @name WHERE ScheduleID = @versionId; SELECT @@ROWCOUNT AS n;`,
    { versionId, name: name.slice(0, 120) });
  return Number(r.recordset?.[0]?.n || 0) > 0;
}

/** Delete a what-if or history version. The master can't be deleted. */
export async function deleteVersion(db: DbExecutor, versionId: string): Promise<void> {
  const r = await db.queryWithParams(
    `SELECT IsLatest FROM aps.SavedSchedules WHERE ScheduleID = @versionId`, { versionId });
  const row = r.recordset?.[0];
  if (!row) throw new VersionError('Version not found', 404);
  if (row.IsLatest) throw new VersionError('The master plan cannot be deleted — commit or revert another version first', 409);
  await db.queryWithParams(`DELETE FROM aps.SavedSchedules WHERE ScheduleID = @versionId`, { versionId });
}

/**
 * Retention: delete history older than `olderThanDays`, always keeping the
 * newest `keepAtLeast` history rows and the most recently exported plan.
 * Master and what-ifs are never purged.
 */
export async function purgeHistory(
  db: DbExecutor, opts: { olderThanDays: number; keepAtLeast: number }
): Promise<number> {
  const days = Math.max(1, Math.floor(opts.olderThanDays));
  const keep = Math.max(0, Math.floor(opts.keepAtLeast));
  const r = await db.queryWithParams(
    `WITH h AS (
       SELECT ScheduleID, SavedAt, Status,
              ROW_NUMBER() OVER (ORDER BY SavedAt DESC) AS rn,
              ROW_NUMBER() OVER (PARTITION BY CASE WHEN Status = 'Exported' THEN 1 ELSE 0 END ORDER BY SavedAt DESC) AS rnStatus
       FROM aps.SavedSchedules
       WHERE IsLatest = 0 AND VersionKind <> 'WhatIf'
     )
     DELETE s FROM aps.SavedSchedules s
     JOIN h ON h.ScheduleID = s.ScheduleID
     WHERE h.rn > @keep
       AND h.SavedAt < DATEADD(day, -@days, GETDATE())
       AND NOT (h.Status = 'Exported' AND h.rnStatus = 1);
     SELECT @@ROWCOUNT AS n;`,
    { keep, days });
  return Number(r.recordset?.[0]?.n || 0);
}

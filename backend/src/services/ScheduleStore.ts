/**
 * ScheduleStore — the only code that writes aps.SavedSchedules' "latest" row.
 *
 * Every write that changes which schedule is latest runs in ONE transaction.
 * Previously generate / save / load-version / scenario-promote each ran
 * "UPDATE IsLatest = 0" and the INSERT as separate statements: a failure in
 * between left NO latest schedule, so the Gantt came up empty after a reload.
 */
import type { DatabaseConnection, DbExecutor } from '../database/connection';

export interface SaveLatestOptions {
  status?: string;
  generatedAt?: Date;
}

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
  db: DatabaseConnection,
  schedule: any,
  opts: SaveLatestOptions = {}
): Promise<{ scheduleId: string; jobCount: number; operationCount: number }> {
  const jobCount = schedule?.jobSchedules?.length || 0;
  const operationCount = countOps(schedule);

  await db.withTransaction(async (tx: DbExecutor) => {
    await tx.query(`UPDATE aps.SavedSchedules SET IsLatest = 0 WHERE IsLatest = 1`);
    await tx.queryWithParams(
      `DELETE FROM aps.SavedSchedules WHERE ScheduleID = @scheduleId`,
      { scheduleId: schedule.scheduleId }
    );
    await tx.queryWithParams(
      `INSERT INTO aps.SavedSchedules
         (ScheduleID, ScheduleData, Status, JobCount, OperationCount,
          HorizonStart, HorizonEnd, GeneratedAt, SavedAt, IsLatest)
       VALUES
         (@scheduleId, @scheduleData, @status, @jobCount, @opCount,
          @horizonStart, @horizonEnd, @generatedAt, GETDATE(), 1)`,
      {
        scheduleId: schedule.scheduleId,
        scheduleData: JSON.stringify(schedule),
        status: opts.status || schedule?.status || 'Draft',
        jobCount,
        opCount: operationCount,
        horizonStart: toDateOrNull(schedule?.planningHorizon?.startDate),
        horizonEnd: toDateOrNull(schedule?.planningHorizon?.endDate),
        generatedAt: opts.generatedAt || toDateOrNull(schedule?.scheduledDate) || new Date(),
      }
    );
  });

  return { scheduleId: schedule.scheduleId, jobCount, operationCount };
}

/** Make an existing saved schedule the latest one, atomically. Returns false if it doesn't exist. */
export async function promoteToLatest(db: DatabaseConnection, scheduleId: string): Promise<boolean> {
  return db.withTransaction(async (tx: DbExecutor) => {
    const exists = await tx.queryWithParams(
      `SELECT 1 AS ok FROM aps.SavedSchedules WHERE ScheduleID = @scheduleId`,
      { scheduleId }
    );
    if (!exists.recordset?.length) return false;
    await tx.query(`UPDATE aps.SavedSchedules SET IsLatest = 0 WHERE IsLatest = 1`);
    await tx.queryWithParams(
      `UPDATE aps.SavedSchedules SET IsLatest = 1 WHERE ScheduleID = @scheduleId`,
      { scheduleId }
    );
    return true;
  });
}

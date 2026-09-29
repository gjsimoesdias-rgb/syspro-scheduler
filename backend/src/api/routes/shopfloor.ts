/**
 * Shop-floor routes (#65).
 *
 * Read-only, mobile-first endpoints for the shop floor view.
 * Returns today's scheduled operations per workcentre so operators
 * can see what's running without needing access to the full planner UI.
 *
 * These routes are intentionally lightweight — no heavy joins, no
 * schedule-generation logic. They read from aps.SavedSchedules only.
 */

import { Router, Request, Response } from 'express';

const router = Router();

/**
 * GET /api/shopfloor/today
 * Returns operations scheduled for today grouped by workcentreId.
 * Uses the latest Approved or Draft schedule.
 */
router.get('/today', async (req: Request, res: Response) => {
  const sysproDb = req.app.locals.sysproDb;
  if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });

  try {
    // Fetch the latest schedule record
    const scheduleResult = await sysproDb.query(
      `SELECT TOP 1 ScheduleData FROM aps.SavedSchedules
       WHERE Status IN ('Approved', 'Draft') AND IsLatest = 1
       ORDER BY SavedAt DESC`
    );

    if (!scheduleResult.recordset?.length) {
      return res.json({ date: new Date().toISOString().slice(0, 10), workcentres: [] });
    }

    const schedule = JSON.parse(scheduleResult.recordset[0].ScheduleData);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Group today's operations by workcentre
    const byWC = new Map<string, any[]>();
    for (const jobSched of schedule.jobSchedules ?? []) {
      for (const op of jobSched.operationSchedules ?? []) {
        const start = new Date(op.plannedStartDate);
        const end   = new Date(op.plannedEndDate);
        // Include op if it overlaps with today
        if (end < todayStart || start > todayEnd) continue;

        const wc = op.workcentreId || 'Unknown';
        if (!byWC.has(wc)) byWC.set(wc, []);
        byWC.get(wc)!.push({
          jobId:            jobSched.jobId,
          opId:             op.opId,
          resourceId:       op.resourceId,
          plannedStartDate: op.plannedStartDate,
          plannedEndDate:   op.plannedEndDate,
        });
      }
    }

    const workcentres = Array.from(byWC.entries()).map(([workcentreId, ops]) => ({
      workcentreId,
      operations: ops.sort(
        (a, b) => new Date(a.plannedStartDate).getTime() - new Date(b.plannedStartDate).getTime()
      ),
    }));

    res.json({ date: todayStart.toISOString().slice(0, 10), workcentres });
  } catch (err) {
    req.log.error({ err }, 'Error fetching shop-floor schedule');
    res.status(500).json({ error: (err as any).message });
  }
});

/**
 * GET /api/shopfloor/workcentre/:wcId
 * Returns today's operations for a single workcentre.
 */
router.get('/workcentre/:wcId', async (req: Request, res: Response) => {
  const { wcId } = req.params;
  const sysproDb = req.app.locals.sysproDb;
  if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });

  try {
    const scheduleResult = await sysproDb.query(
      `SELECT TOP 1 ScheduleData FROM aps.SavedSchedules
       WHERE Status IN ('Approved', 'Draft') AND IsLatest = 1
       ORDER BY SavedAt DESC`
    );
    if (!scheduleResult.recordset?.length) {
      return res.json({ workcentreId: wcId, operations: [] });
    }

    const schedule = JSON.parse(scheduleResult.recordset[0].ScheduleData);
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);

    const ops: any[] = [];
    for (const jobSched of schedule.jobSchedules ?? []) {
      for (const op of jobSched.operationSchedules ?? []) {
        if (op.workcentreId !== wcId) continue;
        const start = new Date(op.plannedStartDate);
        const end   = new Date(op.plannedEndDate);
        if (end < todayStart || start > todayEnd) continue;
        ops.push({
          jobId:            jobSched.jobId,
          opId:             op.opId,
          resourceId:       op.resourceId,
          plannedStartDate: op.plannedStartDate,
          plannedEndDate:   op.plannedEndDate,
        });
      }
    }

    ops.sort((a, b) => new Date(a.plannedStartDate).getTime() - new Date(b.plannedStartDate).getTime());
    res.json({ workcentreId: wcId, operations: ops });
  } catch (err) {
    req.log.error({ err }, 'Error fetching workcentre schedule');
    res.status(500).json({ error: (err as any).message });
  }
});

export default router;

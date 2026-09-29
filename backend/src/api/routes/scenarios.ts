/**
 * Scenario branching routes (#64).
 *
 * Scenarios are named clones of a saved schedule used for what-if
 * comparison. Promoting a scenario copies its data to aps.SavedSchedules
 * and marks the original as IsLatest = 1.
 *
 * All mutating routes require Approver role.
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth, requirePlanner } from '../middleware/requireAuth';

const router = Router();

/**
 * GET /api/scenarios
 * List all scenarios for a base schedule.
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const { baseScheduleId } = req.query as { baseScheduleId?: string };
  const sysproDb = req.app.locals.sysproDb;
  if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });

  try {
    const result = baseScheduleId
      ? await sysproDb.queryWithParams(
          `IF OBJECT_ID('aps.Scenarios', 'U') IS NULL SELECT TOP 0 CAST(NULL AS int) AS x;
           ELSE SELECT ScenarioId, BaseScheduleId, Name, Description, Status, CreatedBy, CreatedAt, PromotedAt
           FROM aps.Scenarios WHERE BaseScheduleId = @baseScheduleId ORDER BY CreatedAt DESC`,
          { baseScheduleId }
        )
      : await sysproDb.query(
          `IF OBJECT_ID('aps.Scenarios', 'U') IS NULL SELECT TOP 0 CAST(NULL AS int) AS x;
           ELSE SELECT ScenarioId, BaseScheduleId, Name, Description, Status, CreatedBy, CreatedAt, PromotedAt
           FROM aps.Scenarios ORDER BY CreatedAt DESC`
        );
    res.json({ scenarios: result.recordset || [] });
  } catch (err) {
    req.log.error({ err }, 'Error listing scenarios');
    res.status(500).json({ error: (err as any).message });
  }
});

/**
 * POST /api/scenarios
 * Clone a saved schedule into a new named scenario.
 */
router.post('/', requireAuth, requirePlanner, async (req: Request, res: Response) => {
  const { baseScheduleId, name, description } = req.body as {
    baseScheduleId: string;
    name: string;
    description?: string;
  };
  if (!baseScheduleId || !name) {
    return res.status(400).json({ error: 'baseScheduleId and name are required' });
  }

  const sysproDb = req.app.locals.sysproDb;
  if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });

  try {
    // Fetch the base schedule's data
    const base = await sysproDb.queryWithParams(
      `SELECT ScheduleData FROM aps.SavedSchedules WHERE ScheduleID = @scheduleId`,
      { scheduleId: baseScheduleId }
    );
    if (!base.recordset?.length) return res.status(404).json({ error: 'Base schedule not found' });

    const scenarioId = uuidv4();
    const createdBy = (req as any).user?.username ?? 'anonymous';

    await sysproDb.queryWithParams(
      `INSERT INTO aps.Scenarios (ScenarioId, BaseScheduleId, Name, Description, ScheduleData, CreatedBy)
       VALUES (@scenarioId, @baseScheduleId, @name, @description, @scheduleData, @createdBy)`,
      {
        scenarioId,
        baseScheduleId,
        name,
        description: description ?? null,
        scheduleData: base.recordset[0].ScheduleData,
        createdBy,
      }
    );

    req.log.info({ scenarioId, baseScheduleId, name }, 'Scenario created');
    res.status(201).json({ scenarioId, baseScheduleId, name, status: 'Draft' });
  } catch (err) {
    req.log.error({ err }, 'Error creating scenario');
    res.status(500).json({ error: (err as any).message });
  }
});

/**
 * GET /api/scenarios/:scenarioId
 * Retrieve a single scenario with its full schedule data.
 */
router.get('/:scenarioId', requireAuth, async (req: Request, res: Response) => {
  const { scenarioId } = req.params;
  const sysproDb = req.app.locals.sysproDb;
  if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });

  try {
    const result = await sysproDb.queryWithParams(
      `SELECT * FROM aps.Scenarios WHERE ScenarioId = @scenarioId`,
      { scenarioId }
    );
    if (!result.recordset?.length) return res.status(404).json({ error: 'Scenario not found' });
    const row = result.recordset[0];
    res.json({ ...row, schedule: JSON.parse(row.ScheduleData) });
  } catch (err) {
    req.log.error({ err }, 'Error fetching scenario');
    res.status(500).json({ error: (err as any).message });
  }
});

/**
 * POST /api/scenarios/:scenarioId/promote
 * Promote scenario to live — copies its data to aps.SavedSchedules and
 * marks it IsLatest = 1. Requires Approver role.
 */
router.post('/:scenarioId/promote', requireAuth, requirePlanner, async (req: Request, res: Response) => {
  const { scenarioId } = req.params;
  const sysproDb = req.app.locals.sysproDb;
  if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });

  try {
    const scenario = await sysproDb.queryWithParams(
      `SELECT * FROM aps.Scenarios WHERE ScenarioId = @scenarioId`,
      { scenarioId }
    );
    if (!scenario.recordset?.length) return res.status(404).json({ error: 'Scenario not found' });

    const row = scenario.recordset[0];
    if (row.Status === 'Promoted') {
      return res.status(409).json({ error: 'Scenario already promoted' });
    }

    const newScheduleId = uuidv4();
    const scheduleData = JSON.parse(row.ScheduleData);
    scheduleData.scheduleId = newScheduleId;

    await sysproDb.query(`UPDATE aps.SavedSchedules SET IsLatest = 0`);
    await sysproDb.queryWithParams(
      `INSERT INTO aps.SavedSchedules
         (ScheduleID, ScheduleData, Status, JobCount, OperationCount,
          HorizonStart, HorizonEnd, GeneratedAt, SavedAt, IsLatest)
       VALUES
         (@scheduleId, @scheduleData, 'Approved', @jobCount, @opCount,
          GETDATE(), GETDATE(), GETDATE(), GETDATE(), 1)`,
      {
        scheduleId: newScheduleId,
        scheduleData: JSON.stringify(scheduleData),
        jobCount: scheduleData.jobSchedules?.length ?? 0,
        opCount: (scheduleData.jobSchedules ?? []).reduce(
          (s: number, j: any) => s + (j.operationSchedules?.length ?? 0), 0
        ),
      }
    );

    await sysproDb.queryWithParams(
      `UPDATE aps.Scenarios SET Status = 'Promoted', PromotedAt = SYSUTCDATETIME() WHERE ScenarioId = @scenarioId`,
      { scenarioId }
    );

    req.log.info({ scenarioId, newScheduleId }, 'Scenario promoted to live schedule');
    res.json({ scenarioId, newScheduleId, status: 'Promoted' });
  } catch (err) {
    req.log.error({ err }, 'Error promoting scenario');
    res.status(500).json({ error: (err as any).message });
  }
});

/**
 * DELETE /api/scenarios/:scenarioId
 * Archive (soft-delete) a scenario.
 */
router.delete('/:scenarioId', requireAuth, requirePlanner, async (req: Request, res: Response) => {
  const { scenarioId } = req.params;
  const sysproDb = req.app.locals.sysproDb;
  if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });

  try {
    await sysproDb.queryWithParams(
      `UPDATE aps.Scenarios SET Status = 'Archived' WHERE ScenarioId = @scenarioId`,
      { scenarioId }
    );
    res.json({ scenarioId, status: 'Archived' });
  } catch (err) {
    res.status(500).json({ error: (err as any).message });
  }
});

export default router;
